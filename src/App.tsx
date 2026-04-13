import { useState, useEffect, useRef, useCallback } from 'react'
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { doc, onSnapshot, setDoc, type FirestoreError } from 'firebase/firestore'
import { auth, db, googleProvider } from './firebase'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loadTasks, saveTasks, daysUntilDue } from './store'
import type { Task } from './types'
import { Check, Pencil, Plus, BellOff, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Toaster, toast } from 'sonner'

function isSnoozed(task: Task): boolean {
  return !!task.snoozedUntil && new Date(task.snoozedUntil) > new Date()
}

function urgency(task: Task): 'overdue' | 'soon' | 'ok' | 'new' | 'snoozed' {
  if (isSnoozed(task)) return 'snoozed'
  if (!task.lastDone) return 'new'
  const days = daysUntilDue(task)
  if (days < 0) return 'overdue'
  if (days <= 7) return 'soon'
  return 'ok'
}

function humanizeDays(d: number): string {
  if (d < 7) return `${d} ${d === 1 ? 'day' : 'days'}`
  if (d < 30) { const w = Math.round(d / 7); return `${w} ${w === 1 ? 'week' : 'weeks'}` }
  const m = Math.round(d / 30); return `${m} ${m === 1 ? 'month' : 'months'}`
}

function dueLabel(task: Task): string {
  if (isSnoozed(task)) {
    const until = new Date(task.snoozedUntil!)
    return `snoozed until ${until.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
  }
  if (!task.lastDone) return "hasn't been done yet"
  const days = daysUntilDue(task)
  if (days < 0) return `${humanizeDays(Math.abs(days))} overdue`
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  return `due in ${humanizeDays(days)}`
}

function intervalLabel(days: number): string {
  if (days === 1) return 'every day'
  if (days % 365 === 0) return days === 365 ? 'every year' : `every ${days / 365} years`
  if (days % 30 === 0) return days === 30 ? 'every month' : `every ${days / 30} months`
  if (days % 7 === 0) return days === 7 ? 'every week' : `every ${days / 7} weeks`
  return `every ${days} days`
}

function toDateInput(iso: string | null): string {
  return iso ? iso.split('T')[0] : ''
}

const urgencyConfig = {
  overdue: { card: 'bg-red-500/[0.07] border-red-500/[0.18]',   text: 'text-red-600 dark:text-red-400' },
  soon:    { card: 'bg-amber-400/[0.07] border-amber-500/[0.2]', text: 'text-amber-600 dark:text-amber-400' },
  ok:      { card: 'bg-card border-border',                       text: 'text-emerald-700 dark:text-emerald-400' },
  new:     { card: 'bg-card border-border',                       text: 'text-muted-foreground' },
  snoozed: { card: 'bg-card border-border',                       text: 'text-muted-foreground' },
}

const SNOOZE_PRESETS = [
  { label: '1 week',  days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
]

type SyncState = 'idle' | 'syncing'

function TaskForm({ name, setName, interval, setInterval, lastDone, setLastDone, today }: {
  name: string; setName: (v: string) => void
  interval: string; setInterval: (v: string) => void
  lastDone: string; setLastDone: (v: string) => void
  today: string
}) {
  return (
    <div className="space-y-5 py-2">
      <div className="space-y-2">
        <Label className="text-[0.7rem] font-semibold tracking-widest uppercase text-muted-foreground">What needs doing?</Label>
        <Input className="h-12 text-[1.0625rem] font-medium bg-secondary border-0 focus-visible:ring-1 tracking-[-0.01em]" placeholder="e.g. Change water filter" value={name} onChange={e => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-2">
        <Label className="text-[0.7rem] font-semibold tracking-widest uppercase text-muted-foreground">Repeat every how many days?</Label>
        <Input className="h-12 text-[1.0625rem] font-medium bg-secondary border-0 focus-visible:ring-1" type="number" min="1" value={interval} onChange={e => setInterval(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label className="text-[0.7rem] font-semibold tracking-widest uppercase text-muted-foreground">Last done <span className="normal-case tracking-normal font-normal opacity-60">(optional)</span></Label>
        <Input className="h-12 text-[1.0625rem] font-medium bg-secondary border-0 focus-visible:ring-1" type="date" value={lastDone} onChange={e => setLastDone(e.target.value)} max={today} />
      </div>
    </div>
  )
}

async function saveToFirestore(uid: string, tasks: Task[]) {
  await setDoc(doc(db, 'users', uid), { tasks }, { merge: true })
}

export default function App() {
  const [user, setUser] = useState<User | null | 'loading'>('loading')
  const [tasks, setTasks] = useState<Task[]>(() =>
    loadTasks().map(t => ({ ...t, snoozedUntil: t.snoozedUntil ?? null }))
  )
  const [syncState, setSyncState] = useState<SyncState>('idle')

  const [showAdd, setShowAdd] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null)
  const [customSnooze, setCustomSnooze] = useState('')
  const [name, setName] = useState('')
  const [interval, setInterval] = useState('30')
  const [lastDone, setLastDone] = useState('')

  useEffect(() => {
    let unsubFirestore: (() => void) | null = null
    let connectTimeout: ReturnType<typeof setTimeout> | null = null

    function clearConnectTimeout() {
      if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null }
    }

    const unsubAuth = onAuthStateChanged(auth, (u) => {
      setUser(u)
      clearConnectTimeout()
      if (unsubFirestore) { unsubFirestore(); unsubFirestore = null }

      if (u) {
        setSyncState('syncing')
        connectTimeout = setTimeout(() => {
          setSyncState('idle')
          toast.error("Can't reach sync server — will retry in background", { duration: 6000 })
        }, 15000)

        unsubFirestore = onSnapshot(
          doc(db, 'users', u.uid),
          (snap) => {
            clearConnectTimeout()
            if (!snap.metadata.hasPendingWrites && snap.exists()) {
              const data = snap.data() as { tasks?: Task[] }
              const t = (data.tasks ?? []).map((t: Task) => ({ ...t, snoozedUntil: t.snoozedUntil ?? null }))
              setTasks(t); saveTasks(t)
            }
            setSyncState('idle')
          },
          (err: FirestoreError) => {
            clearConnectTimeout()
            console.error('Firestore snapshot error:', err.code, err.message)
            toast.error('Sync error: ' + err.message)
            setSyncState('idle')
          }
        )
      }
    })

    return () => { unsubAuth(); if (unsubFirestore) unsubFirestore(); clearConnectTimeout() }
  }, [])

  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncToFirestore = useCallback((t: Task[]) => {
    if (!user || user === 'loading') return
    if (saveTimeout.current) clearTimeout(saveTimeout.current)
    saveTimeout.current = setTimeout(() => {
      saveToFirestore(user.uid, t).catch((err) => {
        console.error('Firestore write error:', err)
        toast.error('Could not save changes — ' + (err?.message ?? 'unknown error'))
      })
    }, 300)
  }, [user])

  function updateTasks(updated: Task[]) {
    setTasks(updated); saveTasks(updated); syncToFirestore(updated)
  }

  async function login() {
    try { await signInWithPopup(auth, googleProvider) }
    catch (e: unknown) {
      const code = (e as {code?: string})?.code
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(e)
        toast.error('Sign-in failed: ' + msg)
      }
    }
  }
  async function logout() { await signOut(auth); setUser(null) }

  function openAdd() { setName(''); setInterval('30'); setLastDone(''); setShowAdd(true) }
  function openEdit(task: Task) {
    setName(task.name); setInterval(String(task.intervalDays))
    setLastDone(toDateInput(task.lastDone)); setConfirmDelete(false); setEditingTask(task)
  }

  function addTask() {
    if (!name.trim()) return
    updateTasks([...tasks, {
      id: crypto.randomUUID(), name: name.trim(),
      intervalDays: parseInt(interval) || 30,
      lastDone: lastDone ? new Date(lastDone).toISOString() : null,
      snoozedUntil: null,
    }])
    setShowAdd(false)
  }
  function saveEdit() {
    if (!editingTask || !name.trim()) return
    updateTasks(tasks.map(t => t.id === editingTask.id
      ? { ...t, name: name.trim(), intervalDays: parseInt(interval) || 30, lastDone: lastDone ? new Date(lastDone).toISOString() : null }
      : t))
    setEditingTask(null)
  }
  function deleteTask(id: string) { updateTasks(tasks.filter(t => t.id !== id)); setEditingTask(null) }
  function markDone(task: Task) {
    const now = new Date().toISOString()
    updateTasks(tasks.map(t => t.id === task.id ? { ...t, lastDone: now, snoozedUntil: null } : t))
  }
  function snooze(taskId: string, days: number) {
    const until = new Date(); until.setDate(until.getDate() + days)
    updateTasks(tasks.map(t => t.id === taskId ? { ...t, snoozedUntil: until.toISOString() } : t))
    setSnoozeTaskId(null); setCustomSnooze('')
  }
  function unsnooze(taskId: string) {
    updateTasks(tasks.map(t => t.id === taskId ? { ...t, snoozedUntil: null } : t))
  }

  const sorted = [...tasks].sort((a, b) => {
    const ua = urgency(a), ub = urgency(b)
    if (ua === 'snoozed' && ub !== 'snoozed') return 1
    if (ub === 'snoozed' && ua !== 'snoozed') return -1
    if (!a.lastDone && !b.lastDone) return 0
    if (!a.lastDone) return -1
    if (!b.lastDone) return -1
    return (new Date(a.lastDone).getTime() + a.intervalDays * 86400000) -
           (new Date(b.lastDone).getTime() + b.intervalDays * 86400000)
  })

  const today = new Date().toISOString().split('T')[0]
  const overdueCount = tasks.filter(t => { const u = urgency(t); return u === 'overdue' || u === 'new' }).length
  const snoozeTask = tasks.find(t => t.id === snoozeTaskId)

  // ── Loading ──────────────────────────────────────────────────────────────
  if (user === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border-2 border-foreground/15 border-t-foreground/60 animate-spin" />
      </div>
    )
  }

  // ── Login ────────────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <Toaster position="bottom-center" richColors />
        <div className="flex-1" />
        <div className="px-8 pb-20 sm:pb-28 max-w-lg">
          <div className="mb-12">
            {/* Display wordmark — scales with viewport, tight tracking at large size */}
            <h1
              className="font-bold tracking-[-0.05em] leading-[0.88]"
              style={{ fontSize: 'clamp(4.5rem, 20vw, 7.5rem)' }}
            >
              pomelo
            </h1>
            <p className="mt-6 text-[1.125rem] text-muted-foreground leading-[1.65]">
              A quiet reminder for everything
              <br />you do on a regular schedule.
            </p>
          </div>
          <Button
            className="w-full h-14 text-[1.0625rem] font-semibold tracking-[-0.01em]"
            onClick={login}
          >
            Continue with Google
          </Button>
        </div>
      </div>
    )
  }

  // ── App ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background pb-32">
      <Toaster position="bottom-center" richColors />
      <div className="max-w-lg mx-auto px-5 sm:px-8">

        {/* Header */}
        <header className="flex items-center justify-between pt-8 pb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-[1.5rem] font-bold tracking-[-0.04em] leading-none">pomelo</h1>
            {syncState === 'syncing' && (
              <div className="w-2 h-2 rounded-full bg-foreground/25 animate-pulse" />
            )}
            {overdueCount > 0 && syncState === 'idle' && (
              <span className="text-[0.7rem] font-bold tracking-[0.06em] uppercase text-red-500 select-none">
                {overdueCount} overdue
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {user.photoURL && (
              <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full opacity-80" />
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
              onClick={logout}
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </header>

        {/* Empty state */}
        {sorted.length === 0 && (
          <div className="pt-12 pb-8">
            <p className="text-[1.75rem] font-bold tracking-[-0.03em] leading-[1.2] text-balance">
              Nothing scheduled yet
            </p>
            <p className="mt-3 text-[1rem] text-muted-foreground leading-[1.6]">
              Tap the + button to add your first recurring task.
            </p>
          </div>
        )}

        {/* Task list */}
        <div className="space-y-3">
          {sorted.map(task => {
            const u = urgency(task)
            const cfg = urgencyConfig[u]
            const snoozed = u === 'snoozed'

            return (
              <div
                key={task.id}
                className={cn(
                  'rounded-2xl border overflow-hidden transition-opacity',
                  cfg.card,
                  snoozed && 'opacity-50'
                )}
              >
                <div className="flex items-center px-5 py-5 gap-3">
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[1.1875rem] font-semibold tracking-[-0.02em] leading-snug truncate">
                      {task.name}
                    </p>
                    <p className="mt-1.5 text-[0.875rem] leading-none">
                      <span className={cn('font-medium', cfg.text)}>{dueLabel(task)}</span>
                      <span className="text-muted-foreground"> · {intervalLabel(task.intervalDays)}</span>
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      className="h-11 w-11 rounded-xl flex items-center justify-center text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 active:bg-emerald-500/20 transition-colors"
                      onClick={() => markDone(task)}
                      title="Mark done"
                    >
                      <Check className="w-5 h-5" />
                    </button>
                    {snoozed ? (
                      <button
                        className="h-11 w-11 rounded-xl flex items-center justify-center text-muted-foreground hover:bg-secondary active:bg-secondary transition-colors"
                        onClick={() => unsnooze(task.id)}
                        title="Wake up"
                      >
                        <BellOff className="w-[1.1rem] h-[1.1rem]" />
                      </button>
                    ) : (
                      <button
                        className="h-11 w-11 rounded-xl flex items-center justify-center text-muted-foreground hover:bg-secondary active:bg-secondary transition-colors"
                        onClick={() => { setSnoozeTaskId(task.id); setCustomSnooze('') }}
                        title="Snooze"
                      >
                        <BellOff className="w-[1.1rem] h-[1.1rem]" />
                      </button>
                    )}
                    <button
                      className="h-11 w-11 rounded-xl flex items-center justify-center text-muted-foreground hover:bg-secondary active:bg-secondary transition-colors"
                      onClick={() => openEdit(task)}
                      title="Edit"
                    >
                      <Pencil className="w-[1rem] h-[1rem]" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* FAB — floating add button, always thumb-reachable */}
      <button
        className="fixed bottom-8 right-6 h-14 w-14 rounded-full bg-foreground text-background shadow-lg shadow-foreground/10 flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
        onClick={openAdd}
        title="Add task"
      >
        <Plus className="w-6 h-6" />
      </button>

      {/* Snooze dialog */}
      <Dialog open={!!snoozeTaskId} onOpenChange={open => !open && setSnoozeTaskId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[1.25rem] font-semibold tracking-[-0.02em] leading-tight">
              Snooze "{snoozeTask?.name}"
            </DialogTitle>
            <p className="text-[0.9375rem] text-muted-foreground leading-snug">Come back to it after:</p>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex gap-2">
              {SNOOZE_PRESETS.map(p => (
                <button
                  key={p.days}
                  className="flex-1 h-12 text-[0.9375rem] font-medium tracking-[-0.01em] border border-border rounded-xl hover:bg-secondary active:bg-secondary transition-colors"
                  onClick={() => snooze(snoozeTaskId!, p.days)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                className="h-12 text-base bg-secondary border-0 focus-visible:ring-1"
                type="date"
                value={customSnooze}
                min={today}
                onChange={e => setCustomSnooze(e.target.value)}
              />
              <Button
                className="h-12 px-5 text-base shrink-0"
                disabled={!customSnooze}
                onClick={() => {
                  const days = Math.round((new Date(customSnooze).getTime() - Date.now()) / 86400000)
                  if (days > 0) snooze(snoozeTaskId!, days)
                }}
              >
                Snooze
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[1.25rem] font-semibold tracking-[-0.02em]">New task</DialogTitle>
          </DialogHeader>
          <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
          <DialogFooter>
            <Button variant="ghost" className="h-12 text-[0.9375rem] font-medium" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button className="h-12 px-6 text-[0.9375rem] font-semibold tracking-[-0.01em]" onClick={addTask}>Add task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingTask} onOpenChange={open => { if (!open) { setEditingTask(null); setConfirmDelete(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[1.25rem] font-semibold tracking-[-0.02em]">Edit task</DialogTitle>
          </DialogHeader>
          {confirmDelete ? (
            <div className="py-3 space-y-5">
              <p className="text-[0.9375rem] text-muted-foreground leading-relaxed">
                Delete <span className="font-semibold text-foreground">{editingTask?.name}</span>? This can't be undone.
              </p>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" className="h-12 text-[0.9375rem] font-medium" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                <Button variant="destructive" className="h-12 text-[0.9375rem] font-semibold" onClick={() => editingTask && deleteTask(editingTask.id)}>Yes, delete it</Button>
              </div>
            </div>
          ) : (
            <>
              <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
              <DialogFooter className="flex-row justify-between sm:justify-between">
                <Button variant="ghost" className="h-12 text-[0.9375rem] font-medium text-muted-foreground hover:text-red-500" onClick={() => setConfirmDelete(true)}>Delete</Button>
                <div className="flex gap-2">
                  <Button variant="ghost" className="h-12 text-[0.9375rem] font-medium" onClick={() => setEditingTask(null)}>Cancel</Button>
                  <Button className="h-12 px-6 text-[0.9375rem] font-semibold tracking-[-0.01em]" onClick={saveEdit}>Save changes</Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
