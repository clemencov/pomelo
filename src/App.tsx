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
import { Pencil, Plus, BellOff, LogOut } from 'lucide-react'
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
    return `Snoozed until ${until.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }
  if (!task.lastDone) return 'Not done yet'
  const days = daysUntilDue(task)
  if (days < 0) return `${humanizeDays(Math.abs(days))} overdue`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${humanizeDays(days)}`
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
  overdue: { label: 'text-red-600 dark:text-red-400',    meta: 'text-red-500/80 dark:text-red-400/70' },
  soon:    { label: 'text-amber-600 dark:text-amber-400', meta: 'text-amber-500/80 dark:text-amber-400/70' },
  ok:      { label: 'text-emerald-700 dark:text-emerald-500', meta: 'text-muted-foreground' },
  new:     { label: 'text-muted-foreground',              meta: 'text-muted-foreground' },
  snoozed: { label: 'text-muted-foreground',              meta: 'text-muted-foreground' },
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
    <div className="space-y-4 py-1">
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-muted-foreground">Task name</Label>
        <Input className="h-10 text-sm bg-secondary border-0 focus-visible:ring-1 rounded-md" placeholder="e.g. Change water filter" value={name} onChange={e => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-muted-foreground">Repeat every (days)</Label>
        <Input className="h-10 text-sm bg-secondary border-0 focus-visible:ring-1 rounded-md" type="number" min="1" value={interval} onChange={e => setInterval(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-muted-foreground">
          Last done <span className="font-normal opacity-55">(optional)</span>
        </Label>
        <Input className="h-10 text-sm bg-secondary border-0 focus-visible:ring-1 rounded-md" type="date" value={lastDone} onChange={e => setLastDone(e.target.value)} max={today} />
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
        toast.error('Could not save — ' + (err?.message ?? 'unknown error'))
      })
    }, 300)
  }, [user])

  function updateTasks(updated: Task[]) {
    setTasks(updated); saveTasks(updated); syncToFirestore(updated)
  }

  async function login() {
    try { await signInWithPopup(auth, googleProvider) }
    catch (e: unknown) {
      const code = (e as { code?: string })?.code
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        toast.error('Sign-in failed: ' + (e instanceof Error ? e.message : String(e)))
        console.error(e)
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
    updateTasks(tasks.map(t => t.id === task.id ? { ...t, lastDone: new Date().toISOString(), snoozedUntil: null } : t))
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
  const snoozeTask = tasks.find(t => t.id === snoozeTaskId)

  // ── Loading ──────────────────────────────────────────────────────────────
  if (user === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-4 h-4 rounded-full border-2 border-foreground/15 border-t-foreground/50 animate-spin" />
      </div>
    )
  }

  // ── Login ────────────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-8">
        <Toaster position="bottom-center" richColors />
        <div className="w-full max-w-xs">
          {/* Logo mark + wordmark */}
          <div className="flex flex-col items-center text-center mb-10">
            <div className="w-12 h-12 rounded-2xl bg-brand mb-5 flex items-center justify-center">
              <span className="text-white text-xl font-bold tracking-tight">p</span>
            </div>
            <h1 className="text-[1.75rem] font-[700] tracking-[-0.04em]">pomelo</h1>
            <p className="mt-2.5 text-[0.9375rem] text-muted-foreground leading-[1.6]">
              Track recurring tasks.<br />Never miss a thing.
            </p>
          </div>
          <Button className="w-full h-10 text-sm font-semibold rounded-md" onClick={login}>
            Continue with Google
          </Button>
        </div>
      </div>
    )
  }

  // ── App ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      <Toaster position="bottom-center" richColors />
      <div className="max-w-2xl mx-auto px-5 sm:px-8 pb-32">

        {/* Header — Notion-style minimal topbar */}
        <header className="flex items-center justify-between py-4 mb-2">
          <div className="flex items-center gap-2.5">
            {/* Logo mark */}
            <div className="w-6 h-6 rounded-md bg-brand flex items-center justify-center shrink-0">
              <span className="text-white text-xs font-bold">p</span>
            </div>
            <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">pomelo</span>
            {syncState === 'syncing' && (
              <span className="w-1.5 h-1.5 rounded-full bg-foreground/20 animate-pulse" />
            )}
          </div>
          <div className="flex items-center gap-1">
            {user.photoURL && (
              <img src={user.photoURL} alt="" className="w-7 h-7 rounded-full opacity-70" />
            )}
            <button
              className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
              onClick={logout}
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {/* Page title */}
        <div className="mb-6">
          <h2 className="text-[2rem] font-[700] tracking-[-0.04em]">My tasks</h2>
        </div>

        {/* Empty state */}
        {sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-[0.9375rem] font-medium text-muted-foreground">No tasks yet</p>
            <p className="mt-1 text-sm text-muted-foreground/70">
              Press the + button to add your first recurring task.
            </p>
          </div>
        )}

        {/* Task list — Notion database rows inside a bordered container */}
        {sorted.length > 0 && (
          <div className="border border-border rounded-lg overflow-hidden bg-card">
            {sorted.map((task, index) => {
              const u = urgency(task)
              const cfg = urgencyConfig[u]
              const snoozed = u === 'snoozed'

              return (
                <div
                  key={task.id}
                  className={cn(
                    'group flex items-start gap-3.5 px-5 py-4',
                    'hover:bg-hover transition-colors',
                    index > 0 && 'border-t border-border',
                    snoozed && 'opacity-40'
                  )}
                >
                  {/* Checkbox — the Notion done button */}
                  <button
                    className="mt-[0.2rem] w-[1.125rem] h-[1.125rem] rounded-[4px] border-[1.5px] border-foreground/25 flex items-center justify-center shrink-0 hover:border-brand hover:bg-brand/8 transition-colors"
                    onClick={() => markDone(task)}
                    title="Mark done"
                  />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[0.9375rem] font-[500] leading-snug tracking-[-0.01em]">
                      {task.name}
                    </p>
                    <p className="mt-0.5 text-[0.8125rem] leading-none">
                      <span className={cfg.label}>{dueLabel(task)}</span>
                      <span className="text-muted-foreground/60"> · {intervalLabel(task.intervalDays)}</span>
                    </p>
                  </div>

                  {/* Actions — visible at reduced opacity, full on hover */}
                  <div className="flex items-center gap-0.5 opacity-30 group-hover:opacity-100 transition-opacity shrink-0">
                    {snoozed ? (
                      <button
                        className="h-7 w-7 flex items-center justify-center rounded-md text-foreground hover:bg-secondary transition-colors"
                        onClick={() => unsnooze(task.id)}
                        title="Wake up"
                      >
                        <BellOff className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        className="h-7 w-7 flex items-center justify-center rounded-md text-foreground hover:bg-secondary transition-colors"
                        onClick={() => { setSnoozeTaskId(task.id); setCustomSnooze('') }}
                        title="Snooze"
                      >
                        <BellOff className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      className="h-7 w-7 flex items-center justify-center rounded-md text-foreground hover:bg-secondary transition-colors"
                      onClick={() => openEdit(task)}
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Add button — inline Notion-style row at bottom of list */}
        <button
          className="mt-1 flex items-center gap-3 w-full px-5 py-3 rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground transition-colors group"
          onClick={openAdd}
        >
          <div className="w-[1.125rem] h-[1.125rem] rounded-[4px] border-[1.5px] border-dashed border-muted-foreground/40 flex items-center justify-center shrink-0 group-hover:border-foreground/40 transition-colors">
            <Plus className="w-2.5 h-2.5" />
          </div>
          <span className="text-sm">New task</span>
        </button>

      </div>

      {/* FAB — visible on mobile as primary add affordance */}
      <button
        className="fixed bottom-8 right-6 h-12 w-12 rounded-full bg-foreground text-background flex items-center justify-center shadow-lg hover:opacity-90 active:scale-95 transition-all sm:hidden"
        onClick={openAdd}
        title="Add task"
      >
        <Plus className="w-5 h-5" strokeWidth={2.5} />
      </button>

      {/* Snooze dialog */}
      <Dialog open={!!snoozeTaskId} onOpenChange={open => !open && setSnoozeTaskId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
              Snooze "{snoozeTask?.name}"
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-1">Come back to it after:</p>
          <div className="space-y-2 pt-1">
            <div className="flex gap-2">
              {SNOOZE_PRESETS.map(p => (
                <button
                  key={p.days}
                  className="flex-1 h-9 text-sm font-medium border border-border rounded-md hover:bg-hover transition-colors"
                  onClick={() => snooze(snoozeTaskId!, p.days)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input className="h-9 text-sm bg-secondary border-0 focus-visible:ring-1 rounded-md" type="date" value={customSnooze} min={today} onChange={e => setCustomSnooze(e.target.value)} />
              <Button
                className="h-9 px-4 text-sm shrink-0 rounded-md"
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
            <DialogTitle className="text-base font-semibold tracking-[-0.01em]">New task</DialogTitle>
          </DialogHeader>
          <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
          <DialogFooter>
            <Button variant="ghost" className="h-9 text-sm rounded-md" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button className="h-9 px-4 text-sm font-semibold rounded-md" onClick={addTask}>Add task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingTask} onOpenChange={open => { if (!open) { setEditingTask(null); setConfirmDelete(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-base font-semibold tracking-[-0.01em]">Edit task</DialogTitle>
          </DialogHeader>
          {confirmDelete ? (
            <div className="py-1 space-y-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Delete <span className="font-semibold text-foreground">"{editingTask?.name}"</span>? This can't be undone.
              </p>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" className="h-9 text-sm rounded-md" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                <Button variant="destructive" className="h-9 text-sm rounded-md" onClick={() => editingTask && deleteTask(editingTask.id)}>Delete</Button>
              </div>
            </div>
          ) : (
            <>
              <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
              <DialogFooter className="flex-row justify-between sm:justify-between">
                <Button variant="ghost" className="h-9 text-sm text-muted-foreground hover:text-destructive rounded-md" onClick={() => setConfirmDelete(true)}>Delete</Button>
                <div className="flex gap-2">
                  <Button variant="ghost" className="h-9 text-sm rounded-md" onClick={() => setEditingTask(null)}>Cancel</Button>
                  <Button className="h-9 px-4 text-sm font-semibold rounded-md" onClick={saveEdit}>Save</Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
