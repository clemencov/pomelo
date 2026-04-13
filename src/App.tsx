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

// Playfair Display italic — used only for the wordmark
const wordmarkStyle = (size: string | number, weight = 700): React.CSSProperties => ({
  fontFamily: '"Playfair Display Variable", Georgia, serif',
  fontStyle: 'italic',
  fontWeight: weight,
  fontSize: typeof size === 'number' ? `${size}rem` : size,
  letterSpacing: '-0.02em',
  lineHeight: 1,
})

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
  if (!task.lastDone) return "Not done yet"
  const days = daysUntilDue(task)
  if (days < 0) return `${humanizeDays(Math.abs(days))} overdue`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${humanizeDays(days)}`
}

function intervalLabel(days: number): string {
  if (days === 1) return 'Every day'
  if (days % 365 === 0) return days === 365 ? 'Every year' : `Every ${days / 365} years`
  if (days % 30 === 0) return days === 30 ? 'Every month' : `Every ${days / 30} months`
  if (days % 7 === 0) return days === 7 ? 'Every week' : `Every ${days / 7} weeks`
  return `Every ${days} days`
}

function toDateInput(iso: string | null): string {
  return iso ? iso.split('T')[0] : ''
}

// Status shown as a badge ABOVE the task name — magazine category label pattern.
// The colored dot + uppercase text creates an immediate urgency signal before
// the eye even reaches the task name.
const urgencyConfig = {
  overdue: {
    badge: 'text-red-600 dark:text-red-400',
    dot:   'bg-red-500',
    card:  'bg-red-50/60 dark:bg-red-500/[0.06]',
  },
  soon: {
    badge: 'text-amber-600 dark:text-amber-400',
    dot:   'bg-amber-500',
    card:  '',
  },
  ok: {
    badge: 'text-emerald-600 dark:text-emerald-500',
    dot:   'bg-emerald-500',
    card:  '',
  },
  new: {
    badge: 'text-muted-foreground',
    dot:   'bg-muted-foreground/40',
    card:  '',
  },
  snoozed: {
    badge: 'text-muted-foreground',
    dot:   'bg-muted-foreground/30',
    card:  '',
  },
}

const SNOOZE_PRESETS = [
  { label: '1 week',  days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
]

type SyncState = 'idle' | 'syncing'

// Defined outside App so React doesn't remount on every keystroke
function TaskForm({ name, setName, interval, setInterval, lastDone, setLastDone, today }: {
  name: string; setName: (v: string) => void
  interval: string; setInterval: (v: string) => void
  lastDone: string; setLastDone: (v: string) => void
  today: string
}) {
  return (
    <div className="space-y-5 py-1">
      <div className="space-y-2">
        <Label className="text-[0.6875rem] font-[700] tracking-[0.1em] uppercase text-muted-foreground">Task name</Label>
        <Input className="h-14 text-[1.0625rem] font-[500] bg-secondary border-0 focus-visible:ring-1 rounded-xl" placeholder="e.g. Change water filter" value={name} onChange={e => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-2">
        <Label className="text-[0.6875rem] font-[700] tracking-[0.1em] uppercase text-muted-foreground">Repeat every (days)</Label>
        <Input className="h-14 text-[1.0625rem] font-[500] bg-secondary border-0 focus-visible:ring-1 rounded-xl" type="number" min="1" value={interval} onChange={e => setInterval(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label className="text-[0.6875rem] font-[700] tracking-[0.1em] uppercase text-muted-foreground">
          Last done <span className="normal-case tracking-normal font-[400] opacity-55">(optional)</span>
        </Label>
        <Input className="h-14 text-[1.0625rem] font-[500] bg-secondary border-0 focus-visible:ring-1 rounded-xl" type="date" value={lastDone} onChange={e => setLastDone(e.target.value)} max={today} />
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
  const overdueCount = tasks.filter(t => urgency(t) === 'overdue').length
  const snoozeTask = tasks.find(t => t.id === snoozeTaskId)

  // ── Loading ──────────────────────────────────────────────────────────────
  if (user === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border-2 border-foreground/15 border-t-foreground/50 animate-spin" />
      </div>
    )
  }

  // ── Login ────────────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-8">
        <Toaster position="bottom-center" richColors />
        <div className="w-full max-w-xs flex flex-col items-center text-center gap-12">
          <div>
            <h1
              style={{ ...wordmarkStyle('clamp(3.75rem, 18vw, 5.5rem)', 800), color: 'hsl(var(--brand))' }}
            >
              pomelo
            </h1>
            <p className="mt-5 text-[1rem] text-muted-foreground leading-[1.72] font-[380]">
              A quiet reminder for the things<br />you do on a regular schedule.
            </p>
          </div>
          <Button
            className="w-full h-[3.5rem] text-[1rem] font-[600] rounded-2xl"
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
    <div className="min-h-screen bg-background pb-36">
      <Toaster position="bottom-center" richColors />
      <div className="max-w-2xl mx-auto px-5 sm:px-8">

        {/* Header */}
        <header className="flex items-center justify-between pt-10 pb-8">
          <div className="flex items-center gap-3">
            <h1 style={{ ...wordmarkStyle('1.875rem', 700), color: 'hsl(var(--brand))' }}>
              pomelo
            </h1>
            {syncState === 'syncing' && (
              <span className="w-1.5 h-1.5 rounded-full bg-foreground/25 animate-pulse" />
            )}
          </div>
          <div className="flex items-center gap-1">
            {user.photoURL && (
              <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full opacity-75" />
            )}
            <Button variant="ghost" size="sm" className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground" onClick={logout}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </header>

        {/* Section label — only shown when something needs attention */}
        {overdueCount > 0 && (
          <p className="mb-5 text-[0.6875rem] font-[700] tracking-[0.1em] uppercase text-red-500">
            {overdueCount} {overdueCount === 1 ? 'task' : 'tasks'} overdue
          </p>
        )}

        {/* Empty state */}
        {sorted.length === 0 && (
          <div className="pt-16 pb-10 max-w-xs">
            <p className="text-[2.25rem] font-[750] tracking-[-0.04em] leading-[1.1]">
              Nothing<br />here yet.
            </p>
            <p className="mt-5 text-[1rem] text-muted-foreground leading-[1.65] font-[400]">
              Add anything you do on a schedule — weekly, monthly, yearly.
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
                  // Light: floating card with shadow, no border
                  // Dark: surface card with subtle border
                  'rounded-2xl bg-white shadow-[var(--shadow-card)]',
                  'dark:bg-card dark:shadow-none dark:border dark:border-border',
                  cfg.card,
                  snoozed && 'opacity-40'
                )}
              >
                <div className="flex gap-5 px-7 py-6">

                  {/* Left: status label → name → interval */}
                  <div className="flex-1 min-w-0">
                    {/* Status badge — magazine category label, above the headline */}
                    <div className={cn('flex items-center gap-1.5 mb-2.5', cfg.badge)}>
                      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', cfg.dot)} />
                      <span className="text-[0.6875rem] font-[700] tracking-[0.07em] uppercase">
                        {dueLabel(task)}
                      </span>
                    </div>

                    {/* Hero task name */}
                    <p className="text-[1.625rem] font-[720] tracking-[-0.03em] leading-[1.15]">
                      {task.name}
                    </p>

                    {/* Interval — tertiary, muted */}
                    <p className="mt-2 text-[0.875rem] text-muted-foreground font-[450]">
                      {intervalLabel(task.intervalDays)}
                    </p>
                  </div>

                  {/* Right: primary action top, secondary actions bottom */}
                  <div className="flex flex-col items-end justify-between shrink-0 py-0.5">
                    {/* Done — primary CTA */}
                    <button
                      className="h-11 w-11 rounded-xl flex items-center justify-center text-brand hover:bg-brand/10 active:bg-brand/15 transition-colors"
                      onClick={() => markDone(task)}
                      title="Mark done"
                    >
                      <Check className="w-5 h-5" strokeWidth={2.5} />
                    </button>

                    {/* Secondary actions */}
                    <div className="flex items-center gap-0.5">
                      {snoozed ? (
                        <button
                          className="h-9 w-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                          onClick={() => unsnooze(task.id)}
                          title="Wake up"
                        >
                          <BellOff className="w-[1rem] h-[1rem]" />
                        </button>
                      ) : (
                        <button
                          className="h-9 w-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                          onClick={() => { setSnoozeTaskId(task.id); setCustomSnooze('') }}
                          title="Snooze"
                        >
                          <BellOff className="w-[1rem] h-[1rem]" />
                        </button>
                      )}
                      <button
                        className="h-9 w-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                        onClick={() => openEdit(task)}
                        title="Edit"
                      >
                        <Pencil className="w-[0.9rem] h-[0.9rem]" />
                      </button>
                    </div>
                  </div>

                </div>
              </div>
            )
          })}
        </div>

      </div>

      {/* FAB */}
      <button
        className="fixed bottom-8 right-6 h-16 w-16 rounded-full bg-brand text-white flex items-center justify-center shadow-[0_4px_20px_hsl(346_65%_47%/0.4)] hover:opacity-90 active:scale-95 transition-all"
        onClick={openAdd}
        title="Add task"
      >
        <Plus className="w-7 h-7" strokeWidth={2.5} />
      </button>

      {/* Snooze dialog */}
      <Dialog open={!!snoozeTaskId} onOpenChange={open => !open && setSnoozeTaskId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[1.375rem] font-[700] tracking-[-0.025em] leading-snug">
              Snooze<br />
              <span className="text-muted-foreground font-[500]">"{snoozeTask?.name}"</span>
            </DialogTitle>
          </DialogHeader>
          <p className="text-[0.9375rem] text-muted-foreground -mt-1">Come back to it after:</p>
          <div className="space-y-3 pt-1">
            <div className="flex gap-2">
              {SNOOZE_PRESETS.map(p => (
                <button
                  key={p.days}
                  className="flex-1 h-14 text-[0.9375rem] font-[600] border border-border rounded-xl hover:bg-secondary active:bg-secondary transition-colors"
                  onClick={() => snooze(snoozeTaskId!, p.days)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input className="h-14 text-base bg-secondary border-0 focus-visible:ring-1 rounded-xl" type="date" value={customSnooze} min={today} onChange={e => setCustomSnooze(e.target.value)} />
              <Button
                className="h-14 px-6 text-base font-[600] shrink-0 rounded-xl"
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
            <DialogTitle className="text-[1.375rem] font-[700] tracking-[-0.025em]">New task</DialogTitle>
          </DialogHeader>
          <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
          <DialogFooter>
            <Button variant="ghost" className="h-13 text-[0.9375rem] font-[500] rounded-xl" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button className="h-13 px-7 text-[0.9375rem] font-[600] rounded-xl" onClick={addTask}>Add task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingTask} onOpenChange={open => { if (!open) { setEditingTask(null); setConfirmDelete(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[1.375rem] font-[700] tracking-[-0.025em]">Edit task</DialogTitle>
          </DialogHeader>
          {confirmDelete ? (
            <div className="py-2 space-y-6">
              <p className="text-[0.9375rem] text-muted-foreground leading-relaxed">
                Delete <span className="font-[600] text-foreground">"{editingTask?.name}"</span>?<br />This can't be undone.
              </p>
              <div className="flex gap-3 justify-end">
                <Button variant="ghost" className="h-13 text-[0.9375rem] font-[500] rounded-xl" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                <Button variant="destructive" className="h-13 text-[0.9375rem] font-[600] rounded-xl" onClick={() => editingTask && deleteTask(editingTask.id)}>Delete</Button>
              </div>
            </div>
          ) : (
            <>
              <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
              <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
                <Button variant="ghost" className="h-13 text-[0.9375rem] font-[500] text-muted-foreground hover:text-destructive rounded-xl" onClick={() => setConfirmDelete(true)}>Delete</Button>
                <div className="flex gap-2">
                  <Button variant="ghost" className="h-13 text-[0.9375rem] font-[500] rounded-xl" onClick={() => setEditingTask(null)}>Cancel</Button>
                  <Button className="h-13 px-6 text-[0.9375rem] font-[600] rounded-xl" onClick={saveEdit}>Save</Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
