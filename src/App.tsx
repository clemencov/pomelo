import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loadTasks, saveTasks, loadLog, saveLog, daysUntilDue, dueDateLabel } from './store'
import type { Task, LogEntry } from './types'

function badgeVariant(task: Task): 'destructive' | 'secondary' | 'outline' {
  if (!task.lastDone) return 'destructive'
  const days = daysUntilDue(task)
  if (days < 0) return 'destructive'
  if (days <= 7) return 'secondary'
  return 'outline'
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks)
  const [log, setLog] = useState<LogEntry[]>(loadLog)
  const [showAdd, setShowAdd] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [name, setName] = useState('')
  const [interval, setInterval] = useState('30')
  const [lastDone, setLastDone] = useState('')

  function addTask() {
    if (!name.trim()) return
    const task: Task = {
      id: crypto.randomUUID(),
      name: name.trim(),
      intervalDays: parseInt(interval) || 30,
      lastDone: lastDone ? new Date(lastDone).toISOString() : null,
    }
    const updated = [...tasks, task]
    setTasks(updated)
    saveTasks(updated)
    setName('')
    setInterval('30')
    setLastDone('')
    setShowAdd(false)
  }

  function markDone(task: Task) {
    const now = new Date().toISOString()
    const updatedTasks = tasks.map(t => t.id === task.id ? { ...t, lastDone: now } : t)
    setTasks(updatedTasks)
    saveTasks(updatedTasks)

    const entry: LogEntry = {
      id: crypto.randomUUID(),
      taskId: task.id,
      taskName: task.name,
      doneAt: now,
    }
    const updatedLog = [entry, ...log]
    setLog(updatedLog)
    saveLog(updatedLog)
  }

  const sorted = [...tasks].sort((a, b) => daysUntilDue(a) - daysUntilDue(b))

  return (
    <div className="max-w-lg mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold tracking-tight">pomelo</h1>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowLog(true)}>Log</Button>
          <Button size="sm" onClick={() => setShowAdd(true)}>+ Add task</Button>
        </div>
      </div>

      {sorted.length === 0 && (
        <p className="text-muted-foreground text-sm text-center py-12">No tasks yet. Add one to get started.</p>
      )}

      <div className="space-y-3">
        {sorted.map(task => (
          <Card key={task.id}>
            <CardContent className="flex items-center justify-between py-4">
              <div className="space-y-1">
                <p className="font-medium">{task.name}</p>
                <p className="text-xs text-muted-foreground">Every {task.intervalDays}d</p>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={badgeVariant(task)}>{dueDateLabel(task)}</Badge>
                <Button size="sm" variant="outline" onClick={() => markDone(task)}>Done</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Add task dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input placeholder="e.g. Change water filter" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()} />
            </div>
            <div className="space-y-1">
              <Label>Repeat every (days)</Label>
              <Input type="number" min="1" value={interval} onChange={e => setInterval(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Last done <span className="text-muted-foreground">(optional)</span></Label>
              <Input type="date" value={lastDone} onChange={e => setLastDone(e.target.value)} max={new Date().toISOString().split('T')[0]} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={addTask}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Log dialog */}
      <Dialog open={showLog} onOpenChange={setShowLog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-96 overflow-y-auto py-2">
            {log.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No entries yet.</p>}
            {log.map(entry => (
              <div key={entry.id} className="flex justify-between text-sm">
                <span>{entry.taskName}</span>
                <span className="text-muted-foreground">{new Date(entry.doneAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
