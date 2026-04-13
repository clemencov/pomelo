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
import { Check, Pencil, Plus, Clock, AlertTriangle, BellOff, LogOut } from 'lucide-react'
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

function dueLabel(task: Task): string {
  if (isSnoozed(task)) {
    const until = new Date(task.snoozedUntil!)
    return `snoozed · ${until.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }
  if (!task.lastDone) return 'never done'
  const days = daysUntilDue(task)
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  return `due in ${days}d`
}

function intervalLabel(days: number): string {
  if (days % 365 === 0) return `/${days / 365}yr`
  if (days % 30 === 0) return `/${days / 30}mo`
  if (days % 7 === 0) return `/${days / 7}wk`
  return `/${days}d`
}

function toDateInput(iso: string | null): string {
  return iso ? iso.split('T')[0] : ''
}

const urgencyConfig = {
  overdue: { dot: 'bg-red-500',    text: 'text-red-600 dark:text-red-400',        icon: AlertTriangle },
  soon:    { dot: 'bg-amber-400',  text: 'text-amber-600 dark:text-amber-500',    icon: Clock },
  ok:      { dot: 'bg-emerald-500',text: 'text-emerald-700 dark:text-emerald-500',icon: Check },
  new:     { dot: 'bg-stone-400',  text: 'text-muted-foreground',                 icon: AlertTriangle },
  snoozed: { dot: 'bg-stone-300',  text: 'text-muted-foreground',                 icon: BellOff },
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
      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">What needs doing?</Label>
        <Input className="h-11 bg-secondary border-0 focus-visible:ring-1" placeholder="e.g. Change water filter" value={name} onChange={e => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">Repeat every (days)</Label>
        <Input className="h-11 bg-secondary border-0 focus-visible:ring-1 font-mono" type="number" min="1" value={interval} onChange={e => setInterval(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">Last done <span className="text-muted-foreground/60">(optional)</span></Label>
        <Input className="h-11 bg-secondary border-0 focus-visible:ring-1 font-mono" type="date" value={lastDone} onChange={e => setLastDone(e.target.value)} max={today} />
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


  if (user === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border-2 border-foreground/15 border-t-foreground/60 animate-spin" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex flex-col justify-end">
        <Toaster position="bottom-center" richColors />
        <div className="px-8 pb-16 max-w-sm space-y-10">
          <div>
            <h1 className="text-6xl font-semibold tracking-tight leading-none">pomelo</h1>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              Stay on top of things that need doing on a schedule.
            </p>
          </div>
          <Button className="w-full h-12 text-base" onClick={login}>
            Continue with Google
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Toaster position="bottom-center" richColors />
      <div className="max-w-2xl mx-auto px-6">

        {/* Header */}
        <header className="flex items-center justify-between py-5 border-b border-border">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight">pomelo</h1>
            {overdueCount > 0 && (
              <span className="font-mono text-xs text-red-500 bg-red-500/10 px-2 py-0.5 rounded-full">
                {overdueCount} overdue
              </span>
            )}
            {syncState === 'syncing' && (
              <div className="w-3.5 h-3.5 rounded-full border-2 border-foreground/15 border-t-foreground/50 animate-spin" />
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" className="h-8 px-3 text-sm" onClick={openAdd}>
              <Plus className="w-3.5 h-3.5 mr-1" />
              Add
            </Button>
            <div className="flex items-center gap-1 pl-2 border-l border-border">
              <img src={user.photoURL ?? ''} alt="" className="w-6 h-6 rounded-full opacity-75" />
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground" onClick={logout}>
                <LogOut className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </header>

        {/* Empty state */}
        {sorted.length === 0 && (
          <div className="flex flex-col items-center py-32 text-center">
            <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center mb-4">
              <Check className="w-4 h-4 text-muted-foreground" />
            </div>
            <p className="font-medium text-sm">Nothing scheduled yet</p>
            <p className="text-sm text-muted-foreground mt-1">Add tasks you do on a regular cycle.</p>
          </div>
        )}

        {/* Task list */}
        <div className="space-y-2 py-4">
          {sorted.map(task => {
            const u = urgency(task)
            const cfg = urgencyConfig[u]
            const snoozed = u === 'snoozed'

            return (
              <div key={task.id} className={cn(
                'flex items-center rounded-xl border border-border bg-card overflow-hidden group transition-opacity',
                snoozed && 'opacity-50'
              )}>
                {/* Left accent bar */}
                <div className={cn('w-1 self-stretch shrink-0', cfg.dot)} />

                <div className="flex items-center gap-3 flex-1 min-w-0 px-4 py-3.5">
                  {/* Name + status */}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate leading-snug">{task.name}</p>
                    <p className={cn('text-xs mt-0.5 font-mono', cfg.text)}>{dueLabel(task)}</p>
                  </div>

                  {/* Interval */}
                  <span className="font-mono text-xs text-muted-foreground shrink-0">{intervalLabel(task.intervalDays)}</span>

                  {/* Actions */}
                  <div className="flex items-center gap-0.5 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-emerald-600 hover:bg-secondary transition-colors"
                      onClick={() => markDone(task)} title="Mark done"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    {snoozed ? (
                      <button className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                        onClick={() => unsnooze(task.id)} title="Unsnooze">
                        <BellOff className="w-4 h-4" />
                      </button>
                    ) : (
                      <button className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                        onClick={() => { setSnoozeTaskId(task.id); setCustomSnooze('') }} title="Snooze">
                        <BellOff className="w-4 h-4" />
                      </button>
                    )}
                    <button className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                      onClick={() => openEdit(task)} title="Edit">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Snooze dialog */}
        <Dialog open={!!snoozeTaskId} onOpenChange={open => !open && setSnoozeTaskId(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="text-base">Snooze "{snoozeTask?.name}"</DialogTitle>
              <p className="text-sm text-muted-foreground">Remind you again after:</p>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="flex gap-2">
                {SNOOZE_PRESETS.map(p => (
                  <button key={p.days}
                    className="flex-1 h-10 font-mono text-sm border border-border rounded hover:bg-secondary transition-colors"
                    onClick={() => snooze(snoozeTaskId!, p.days)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input className="h-10 font-mono bg-secondary border-0 focus-visible:ring-1" type="date" value={customSnooze} min={today} onChange={e => setCustomSnooze(e.target.value)} />
                <Button className="h-10 px-4 text-sm shrink-0" disabled={!customSnooze}
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
              <DialogTitle>Add a task</DialogTitle>
            </DialogHeader>
            <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
            <DialogFooter>
              <Button variant="ghost" className="h-10" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button className="h-10 px-5" onClick={addTask}>Add task</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit dialog */}
        <Dialog open={!!editingTask} onOpenChange={open => { if (!open) { setEditingTask(null); setConfirmDelete(false) } }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit task</DialogTitle>
            </DialogHeader>
            {confirmDelete ? (
              <div className="py-3 space-y-4">
                <p className="text-sm text-muted-foreground">Delete <span className="font-medium text-foreground">{editingTask?.name}</span>? This can't be undone.</p>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" className="h-10" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                  <Button variant="destructive" className="h-10" onClick={() => editingTask && deleteTask(editingTask.id)}>Yes, delete</Button>
                </div>
              </div>
            ) : (
              <>
                <TaskForm name={name} setName={setName} interval={interval} setInterval={setInterval} lastDone={lastDone} setLastDone={setLastDone} today={today} />
                <DialogFooter className="flex-row justify-between sm:justify-between">
                  <Button variant="ghost" className="h-10 text-muted-foreground hover:text-red-500" onClick={() => setConfirmDelete(true)}>Delete</Button>
                  <div className="flex gap-2">
                    <Button variant="ghost" className="h-10" onClick={() => setEditingTask(null)}>Cancel</Button>
                    <Button className="h-10 px-5" onClick={saveEdit}>Save changes</Button>
                  </div>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>


      </div>
    </div>
  )
}
