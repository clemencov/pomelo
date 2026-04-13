import { useState, useEffect, useRef, useCallback } from 'react'
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { auth, db, googleProvider } from './firebase'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loadTasks, saveTasks, loadLog, saveLog, daysUntilDue } from './store'
import type { Task, LogEntry } from './types'
import { Check, Pencil, Plus, ScrollText, Clock, AlertTriangle, BellOff, LogOut, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

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
    return `snoozed until ${until.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }
  if (!task.lastDone) return 'Never done'
  const days = daysUntilDue(task)
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `In ${days}d`
}

function intervalLabel(days: number): string {
  if (days % 365 === 0) return `every ${days / 365}yr`
  if (days % 30 === 0) return `every ${days / 30}mo`
  if (days % 7 === 0) return `every ${days / 7}wk`
  return `every ${days}d`
}

function toDateInput(iso: string | null): string {
  return iso ? iso.split('T')[0] : ''
}

const urgencyConfig = {
  overdue: { bar: 'bg-red-500',     label: 'text-red-600 dark:text-red-400',         icon: AlertTriangle },
  soon:    { bar: 'bg-amber-400',   label: 'text-amber-600 dark:text-amber-400',     icon: Clock },
  ok:      { bar: 'bg-emerald-400', label: 'text-emerald-600 dark:text-emerald-400', icon: Check },
  new:     { bar: 'bg-slate-300',   label: 'text-muted-foreground',                  icon: AlertTriangle },
  snoozed: { bar: 'bg-violet-300',  label: 'text-violet-500 dark:text-violet-400',   icon: BellOff },
}

const SNOOZE_PRESETS = [
  { label: '1 week',  days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
]

type SyncState = 'idle' | 'syncing' | 'error'

async function loadFromFirestore(uid: string) {
  const snap = await getDoc(doc(db, 'users', uid))
  if (!snap.exists()) return null
  return snap.data() as { tasks: Task[]; log: LogEntry[] }
}

async function saveToFirestore(uid: string, tasks: Task[], log: LogEntry[]) {
  await setDoc(doc(db, 'users', uid), { tasks, log })
}

export default function App() {
  const [user, setUser] = useState<User | null | 'loading'>('loading')
  const [tasks, setTasks] = useState<Task[]>(() =>
    loadTasks().map(t => ({ ...t, snoozedUntil: t.snoozedUntil ?? null }))
  )
  const [log, setLog] = useState<LogEntry[]>(loadLog)
  const [syncState, setSyncState] = useState<SyncState>('idle')

  // UI state
  const [showAdd, setShowAdd] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null)
  const [customSnooze, setCustomSnooze] = useState('')
  const [name, setName] = useState('')
  const [interval, setInterval] = useState('30')
  const [lastDone, setLastDone] = useState('')

  // Auth listener
  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u)
      if (u) {
        setSyncState('syncing')
        try {
          const data = await loadFromFirestore(u.uid)
          if (data) {
            const t = data.tasks.map((t: Task) => ({ ...t, snoozedUntil: t.snoozedUntil ?? null }))
            setTasks(t); saveTasks(t)
            setLog(data.log); saveLog(data.log)
          }
          setSyncState('idle')
        } catch {
          setSyncState('error')
        }
      }
    })
  }, [])

  // Debounced save to Firestore
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncToFirestore = useCallback((t: Task[], l: LogEntry[]) => {
    if (!user || user === 'loading') return
    if (saveTimeout.current) clearTimeout(saveTimeout.current)
    saveTimeout.current = setTimeout(async () => {
      setSyncState('syncing')
      try {
        await saveToFirestore(user.uid, t, l)
        setSyncState('idle')
      } catch {
        setSyncState('error')
      }
    }, 1000)
  }, [user])

  function updateTasks(updated: Task[]) {
    setTasks(updated); saveTasks(updated)
    syncToFirestore(updated, log)
  }

  function updateLog(t: Task[], l: LogEntry[]) {
    setTasks(t); saveTasks(t)
    setLog(l); saveLog(l)
    syncToFirestore(t, l)
  }

  async function login() {
    try { await signInWithPopup(auth, googleProvider) }
    catch (e) { console.error(e) }
  }

  async function logout() {
    await signOut(auth)
    setUser(null)
  }

  // Task operations
  function openAdd() { setName(''); setInterval('30'); setLastDone(''); setShowAdd(true) }

  function openEdit(task: Task) {
    setName(task.name); setInterval(String(task.intervalDays))
    setLastDone(toDateInput(task.lastDone)); setConfirmDelete(false)
    setEditingTask(task)
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

  function deleteTask(id: string) {
    updateTasks(tasks.filter(t => t.id !== id))
    setEditingTask(null)
  }

  function markDone(task: Task) {
    const now = new Date().toISOString()
    const updatedTasks = tasks.map(t => t.id === task.id ? { ...t, lastDone: now, snoozedUntil: null } : t)
    const updatedLog = [{ id: crypto.randomUUID(), taskId: task.id, taskName: task.name, doneAt: now }, ...log]
    updateLog(updatedTasks, updatedLog)
  }

  function snooze(taskId: string, days: number) {
    const until = new Date()
    until.setDate(until.getDate() + days)
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
    const aDue = new Date(a.lastDone).getTime() + a.intervalDays * 86400000
    const bDue = new Date(b.lastDone).getTime() + b.intervalDays * 86400000
    return aDue - bDue
  })

  const today = new Date().toISOString().split('T')[0]
  const overdueCount = tasks.filter(t => { const u = urgency(t); return u === 'overdue' || u === 'new' }).length
  const snoozeTask = snoozeTaskId ? tasks.find(t => t.id === snoozeTaskId) : null

  const TaskForm = () => (
    <div className="space-y-6 py-2">
      <div className="space-y-2">
        <Label className="text-base">Name</Label>
        <Input className="text-base h-12" placeholder="e.g. Change water filter" value={name} onChange={e => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-2">
        <Label className="text-base">Repeat every (days)</Label>
        <Input className="text-base h-12" type="number" min="1" value={interval} onChange={e => setInterval(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label className="text-base">Last done <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input className="text-base h-12" type="date" value={lastDone} onChange={e => setLastDone(e.target.value)} max={today} />
      </div>
    </div>
  )

  // Loading
  if (user === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-muted-foreground animate-spin" />
      </div>
    )
  }

  // Login screen
  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <div className="text-center space-y-6 px-6">
          <h1 className="text-4xl font-semibold tracking-tight">pomelo</h1>
          <p className="text-muted-foreground text-base">Recurring task manager — synced to your account</p>
          <Button className="text-base h-12 px-8" onClick={login}>
            Sign in with Google
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-2xl mx-auto px-6 py-16">

        {/* Header */}
        <div className="flex items-center justify-between mb-12">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">pomelo</h1>
            {overdueCount > 0 && (
              <p className="text-base text-red-500 mt-1">{overdueCount} task{overdueCount > 1 ? 's' : ''} need attention</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {syncState === 'syncing' && <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />}
            {syncState === 'error' && <span className="text-xs text-red-500">sync failed</span>}
            <Button variant="ghost" className="text-muted-foreground text-base h-11 px-4" onClick={() => setShowLog(true)}>
              <ScrollText className="w-5 h-5 mr-2" />
              Log
            </Button>
            <Button className="text-base h-11 px-5" onClick={openAdd}>
              <Plus className="w-5 h-5 mr-1.5" />
              Add task
            </Button>
            <div className="flex items-center gap-2 pl-2 border-l border-border">
              <img src={user.photoURL ?? ''} alt={user.displayName ?? ''} className="w-8 h-8 rounded-full" />
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" onClick={logout} title="Sign out">
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Empty state */}
        {sorted.length === 0 && (
          <div className="text-center py-32 text-muted-foreground">
            <BellOff className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <p className="text-lg font-medium">No recurring tasks</p>
            <p className="text-base mt-1">Add something you do regularly</p>
          </div>
        )}

        {/* Task list */}
        <div className="space-y-3">
          {sorted.map(task => {
            const u = urgency(task)
            const cfg = urgencyConfig[u]
            const Icon = cfg.icon
            const snoozed = u === 'snoozed'
            return (
              <Card key={task.id} className={cn('overflow-hidden border-0 shadow-sm', snoozed && 'opacity-60')}>
                <div className={cn('h-1.5 w-full', cfg.bar)} />
                <CardContent className="flex items-center gap-6 py-6 px-7">
                  <Icon className={cn('w-6 h-6 shrink-0', cfg.label)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-medium truncate">{task.name}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">{intervalLabel(task.intervalDays)}</p>
                  </div>
                  <div className="text-right shrink-0 space-y-1">
                    <p className={cn('text-sm font-semibold', cfg.label)}>{dueLabel(task)}</p>
                    <p className="text-xs text-muted-foreground">
                      {task.lastDone
                        ? `done ${new Date(task.lastDone).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                        : 'never done'}
                    </p>
                    {task.lastDone && !snoozed && (
                      <p className="text-xs text-muted-foreground">
                        due {new Date(new Date(task.lastDone).getTime() + task.intervalDays * 86400000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" className="h-11 w-11 p-0 text-muted-foreground hover:text-emerald-600" onClick={() => markDone(task)} title="Mark done">
                      <Check className="w-5 h-5" />
                    </Button>
                    {snoozed ? (
                      <Button variant="ghost" className="h-11 w-11 p-0 text-violet-400 hover:text-violet-600" onClick={() => unsnooze(task.id)} title="Unsnooze">
                        <BellOff className="w-5 h-5" />
                      </Button>
                    ) : (
                      <Button variant="ghost" className="h-11 w-11 p-0 text-muted-foreground hover:text-violet-500" onClick={() => { setSnoozeTaskId(task.id); setCustomSnooze('') }} title="Snooze">
                        <BellOff className="w-5 h-5" />
                      </Button>
                    )}
                    <Button variant="ghost" className="h-11 w-11 p-0 text-muted-foreground" onClick={() => openEdit(task)} title="Edit">
                      <Pencil className="w-4.5 h-4.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* Snooze dialog */}
        <Dialog open={!!snoozeTaskId} onOpenChange={open => !open && setSnoozeTaskId(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle className="text-xl">Snooze — {snoozeTask?.name}</DialogTitle></DialogHeader>
            <div className="py-2 space-y-4">
              <div className="flex gap-2">
                {SNOOZE_PRESETS.map(p => (
                  <Button key={p.days} variant="outline" className="flex-1 h-11 text-base" onClick={() => snooze(snoozeTaskId!, p.days)}>
                    {p.label}
                  </Button>
                ))}
              </div>
              <div className="flex gap-2 items-center">
                <Input className="text-base h-11" type="date" value={customSnooze} min={today} onChange={e => setCustomSnooze(e.target.value)} />
                <Button className="h-11 px-5 text-base shrink-0" disabled={!customSnooze}
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
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle className="text-xl">Add task</DialogTitle></DialogHeader>
            <TaskForm />
            <DialogFooter>
              <Button variant="ghost" className="text-base h-11" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button className="text-base h-11 px-6" onClick={addTask}>Add task</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit dialog */}
        <Dialog open={!!editingTask} onOpenChange={open => { if (!open) { setEditingTask(null); setConfirmDelete(false) } }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle className="text-xl">Edit task</DialogTitle></DialogHeader>
            {confirmDelete ? (
              <div className="py-2 space-y-5">
                <p className="text-base text-muted-foreground">Permanently delete <span className="font-medium text-foreground">{editingTask?.name}</span>? This cannot be undone.</p>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" className="text-base h-11" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                  <Button variant="destructive" className="text-base h-11" onClick={() => editingTask && deleteTask(editingTask.id)}>Delete permanently</Button>
                </div>
              </div>
            ) : (
              <>
                <TaskForm />
                <DialogFooter className="flex-row justify-between sm:justify-between">
                  <Button variant="ghost" className="text-base h-11 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950" onClick={() => setConfirmDelete(true)}>Delete</Button>
                  <div className="flex gap-2">
                    <Button variant="ghost" className="text-base h-11" onClick={() => setEditingTask(null)}>Cancel</Button>
                    <Button className="text-base h-11 px-6" onClick={saveEdit}>Save</Button>
                  </div>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* Log dialog */}
        <Dialog open={showLog} onOpenChange={setShowLog}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle className="text-xl">History</DialogTitle></DialogHeader>
            <div className="max-h-[28rem] overflow-y-auto -mx-1 px-1">
              {log.length === 0 && <p className="text-base text-muted-foreground text-center py-10">No entries yet.</p>}
              <div className="space-y-1 py-2">
                {log.map(entry => (
                  <div key={entry.id} className="flex items-center justify-between py-3 px-3 rounded-md hover:bg-slate-50 dark:hover:bg-slate-900">
                    <div className="flex items-center gap-3">
                      <Check className="w-4 h-4 text-emerald-500" />
                      <span className="text-base">{entry.taskName}</span>
                    </div>
                    <span className="text-sm text-muted-foreground">{new Date(entry.doneAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                ))}
              </div>
            </div>
          </DialogContent>
        </Dialog>

      </div>
    </div>
  )
}
