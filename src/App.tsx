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
    return `Snoozed · ${until.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }
  if (!task.lastDone) return 'New'
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

// Left accent bar color + badge style per urgency level.
// The bar is the primary visual signal — a 3px vertical stripe.
// In dark mode it gets a matching glow via box-shadow.
const urgencyConfig = {
  overdue: {
    bar:   'bg-red-500',
    glow:  '[box-shadow:inset_3px_0_0_hsl(4_86%_55%),0_0_20px_hsl(4_86%_55%/0.12)]',
    badge: 'bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400',
  },
  soon: {
    bar:   'bg-amber-400',
    glow:  '[box-shadow:inset_3px_0_0_hsl(43_96%_56%),0_0_20px_hsl(43_96%_56%/0.10)]',
    badge: 'bg-amber-400/15 text-amber-600 dark:bg-amber-400/15 dark:text-amber-400',
  },
  ok: {
    bar:   'bg-emerald-500',
    glow:  '',
    badge: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/12 dark:text-emerald-400',
  },
  new: {
    bar:   'bg-brand',
    glow:  '',
    badge: 'bg-brand/10 text-brand',
  },
  snoozed: {
    bar:   'bg-muted-foreground/25',
    glow:  '',
    badge: 'bg-secondary text-muted-foreground',
  },
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
        <Label className="text-[0.6875rem] font-[600] tracking-[0.08em] uppercase text-muted-foreground">Task name</Label>
        <Input className="h-11 text-[0.9375rem] bg-secondary border-0 focus-visible:ring-1 focus-visible:ring-brand/50 rounded-lg" placeholder="e.g. Change water filter" value={name} onChange={e => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[0.6875rem] font-[600] tracking-[0.08em] uppercase text-muted-foreground">Repeat every (days)</Label>
        <Input className="h-11 text-[0.9375rem] bg-secondary border-0 focus-visible:ring-1 focus-visible:ring-brand/50 rounded-lg" type="number" min="1" value={interval} onChange={e => setInterval(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[0.6875rem] font-[600] tracking-[0.08em] uppercase text-muted-foreground">
          Last done <span className="normal-case tracking-normal font-[400] opacity-50">(optional)</span>
        </Label>
        <Input className="h-11 text-[0.9375rem] bg-secondary border-0 focus-visible:ring-1 focus-visible:ring-brand/50 rounded-lg" type="date" value={lastDone} onChange={e => setLastDone(e.target.value)} max={today} />
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
  const overdueCount = tasks.filter(t => urgency(t) === 'overdue').length

  // ── Loading ──────────────────────────────────────────────────────────────
  if (user === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border-2 border-brand/20 border-t-brand animate-spin" />
      </div>
    )
  }

  // ── Login ────────────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-8"
        style={{ background: 'radial-gradient(ellipse 120% 60% at 50% -10%, hsl(238 84% 60% / 0.08) 0%, hsl(var(--background)) 60%)' }}
      >
        <Toaster position="bottom-center" richColors />
        <div className="w-full max-w-sm flex flex-col items-center text-center">

          {/* Logo */}
          <div className="mb-10">
            <div
              className="w-16 h-16 rounded-2xl bg-brand mx-auto mb-6 flex items-center justify-center"
              style={{ boxShadow: '0 8px 32px hsl(238 84% 60% / 0.35)' }}
            >
              <span className="text-white text-2xl font-[700] tracking-[-0.04em]">p</span>
            </div>
            <h1 className="text-[2.5rem] font-[700] tracking-[-0.05em] leading-none">
              pomelo
            </h1>
            <p className="mt-3 text-[1rem] text-muted-foreground leading-[1.6] font-[400]">
              Track recurring tasks.<br />Never miss what matters.
            </p>
          </div>

          <Button
            className="w-full h-11 text-[0.9375rem] font-[600] rounded-xl"
            style={{ boxShadow: '0 4px 14px hsl(238 84% 60% / 0.35)' }}
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
    <div className="min-h-screen bg-background"
      style={{ background: 'radial-gradient(ellipse 120% 40% at 50% -5%, hsl(238 84% 60% / 0.06) 0%, hsl(var(--background)) 55%)' }}
    >
      <Toaster position="bottom-center" richColors />
      <div className="max-w-2xl mx-auto px-5 sm:px-8 pb-32">

        {/* Header */}
        <header className="flex items-center justify-between pt-8 pb-8">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center shrink-0"
              style={{ boxShadow: '0 2px 8px hsl(238 84% 60% / 0.4)' }}
            >
              <span className="text-white text-sm font-[700]">p</span>
            </div>
            <span className="text-[1rem] font-[600] tracking-[-0.02em]">pomelo</span>
            {syncState === 'syncing' && (
              <span className="w-1.5 h-1.5 rounded-full bg-brand/40 animate-pulse" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openAdd}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-brand text-white text-[0.8125rem] font-[600] hover:opacity-90 transition-opacity"
              style={{ boxShadow: '0 2px 8px hsl(238 84% 60% / 0.35)' }}
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
              Add task
            </button>
            {user.photoURL && (
              <img src={user.photoURL} alt="" className="w-7 h-7 rounded-full opacity-80" />
            )}
            <button
              className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              onClick={logout}
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {/* Summary line */}
        {tasks.length > 0 && (
          <div className="flex items-baseline gap-2 mb-6">
            <h2 className="text-[2rem] font-[700] tracking-[-0.04em] leading-none">
              {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
            </h2>
            {overdueCount > 0 && (
              <span className="text-[0.875rem] font-[500] text-red-500">
                · {overdueCount} overdue
              </span>
            )}
          </div>
        )}

        {/* Empty state */}
        {sorted.length === 0 && (
          <div className="pt-20 pb-10">
            <div className="w-12 h-12 rounded-2xl bg-secondary flex items-center justify-center mb-6">
              <Plus className="w-5 h-5 text-muted-foreground" />
            </div>
            <h2 className="text-[1.75rem] font-[700] tracking-[-0.04em] leading-tight">
              Nothing yet.
            </h2>
            <p className="mt-2 text-[0.9375rem] text-muted-foreground leading-[1.6]">
              Add tasks you do on a schedule —<br />
              weekly, monthly, or yearly.
            </p>
          </div>
        )}

        {/* Task cards */}
        <div className="space-y-2.5">
          {sorted.map(task => {
            const u = urgency(task)
            const cfg = urgencyConfig[u]
            const snoozed = u === 'snoozed'

            return (
              <div
                key={task.id}
                className={cn(
                  'group relative rounded-xl overflow-hidden transition-all',
                  // Light: white card with shadow
                  'bg-card shadow-[0_1px_3px_hsl(240_10%_8%/0.06),0_4px_16px_hsl(240_10%_8%/0.07)]',
                  // Dark: surface with border + optional glow
                  'dark:shadow-none dark:border dark:border-border',
                  u === 'overdue' && 'dark:[box-shadow:inset_3px_0_0_hsl(4_86%_55%),0_0_24px_hsl(4_86%_55%/0.10)]',
                  u === 'soon'    && 'dark:[box-shadow:inset_3px_0_0_hsl(43_96%_56%),0_0_24px_hsl(43_96%_56%/0.08)]',
                  snoozed && 'opacity-40'
                )}
              >
                {/* Left urgency bar — the fastest visual signal */}
                <div className={cn('absolute inset-y-0 left-0 w-[3px]', cfg.bar)} />

                <div className="flex items-center gap-4 pl-6 pr-4 py-5">

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    {/* Badge */}
                    <span className={cn(
                      'inline-flex items-center h-5 px-2 rounded-full text-[0.6875rem] font-[600] tracking-[0.02em] mb-2',
                      cfg.badge
                    )}>
                      {dueLabel(task)}
                    </span>

                    {/* Hero task name */}
                    <p className="text-[1.1875rem] font-[600] tracking-[-0.025em] leading-[1.25] truncate">
                      {task.name}
                    </p>

                    {/* Interval */}
                    <p className="mt-1 text-[0.8125rem] text-muted-foreground font-[400]">
                      {intervalLabel(task.intervalDays)}
                    </p>
                  </div>

                  {/* Done button — primary CTA */}
                  <button
                    className={cn(
                      'w-10 h-10 rounded-full flex items-center justify-center shrink-0',
                      'border-2 border-border text-muted-foreground/50',
                      'hover:border-brand hover:text-brand hover:bg-brand/8',
                      'active:scale-95 transition-all'
                    )}
                    onClick={() => markDone(task)}
                    title="Mark done"
                  >
                    <Check className="w-4 h-4" strokeWidth={2.5} />
                  </button>

                  {/* Secondary actions */}
                  <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {snoozed ? (
                      <button
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                        onClick={() => unsnooze(task.id)} title="Wake up"
                      >
                        <BellOff className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                        onClick={() => { setSnoozeTaskId(task.id); setCustomSnooze('') }} title="Snooze"
                      >
                        <BellOff className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                      onClick={() => openEdit(task)} title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>

                </div>
              </div>
            )
          })}
        </div>

      </div>

      {/* Mobile FAB */}
      <button
        className="fixed bottom-8 right-6 h-14 w-14 rounded-full bg-brand text-white flex items-center justify-center sm:hidden active:scale-95 transition-transform"
        style={{ boxShadow: '0 6px 24px hsl(238 84% 60% / 0.45)' }}
        onClick={openAdd}
      >
        <Plus className="w-6 h-6" strokeWidth={2.5} />
      </button>

      {/* Snooze dialog */}
      <Dialog open={!!snoozeTaskId} onOpenChange={open => !open && setSnoozeTaskId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[1.125rem] font-[600] tracking-[-0.02em]">
              Snooze "{snoozeTask?.name}"
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-1">Come back to it after:</p>
          <div className="space-y-2 pt-1">
            <div className="flex gap-2">
              {SNOOZE_PRESETS.map(p => (
                <button
                  key={p.days}
                  className="flex-1 h-10 text-sm font-[600] border border-border rounded-lg hover:bg-secondary hover:border-brand/30 transition-colors"
                  onClick={() => snooze(snoozeTaskId!, p.days)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input className="h-10 text-sm bg-secondary border-0 focus-visible:ring-1 focus-visible:ring-brand/50 rounded-lg" type="date" value={customSnooze} min={today} onChange={e => setCustomSnooze(e.target.value)} />
              <Button className="h-10 px-4 text-sm font-[600] shrink-0 rounded-lg" disabled={!customSnooze}
                onClick={() => {
                  const days = Math.round((new Date(customSnooze).getTime() - Date.now()) / 86400000)
                  if (days > 0) snooze(snoozeTaskId!, days)
                }}>
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
            <DialogTitle className="text-[1.125rem] font-[600] tracking-[-0.02em]">New task</DialogTitle>
          </DialogHeader>
          <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
          <DialogFooter>
            <Button variant="ghost" className="h-10 text-sm rounded-lg" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button className="h-10 px-5 text-sm font-[600] rounded-lg" onClick={addTask}>Add task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingTask} onOpenChange={open => { if (!open) { setEditingTask(null); setConfirmDelete(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[1.125rem] font-[600] tracking-[-0.02em]">Edit task</DialogTitle>
          </DialogHeader>
          {confirmDelete ? (
            <div className="py-1 space-y-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Delete <span className="font-[600] text-foreground">"{editingTask?.name}"</span>? This can't be undone.
              </p>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" className="h-10 text-sm rounded-lg" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                <Button variant="destructive" className="h-10 text-sm rounded-lg" onClick={() => editingTask && deleteTask(editingTask.id)}>Delete</Button>
              </div>
            </div>
          ) : (
            <>
              <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
              <DialogFooter className="flex-row justify-between sm:justify-between">
                <Button variant="ghost" className="h-10 text-sm text-muted-foreground hover:text-destructive rounded-lg" onClick={() => setConfirmDelete(true)}>Delete</Button>
                <div className="flex gap-2">
                  <Button variant="ghost" className="h-10 text-sm rounded-lg" onClick={() => setEditingTask(null)}>Cancel</Button>
                  <Button className="h-10 px-5 text-sm font-[600] rounded-lg" onClick={saveEdit}>Save</Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
