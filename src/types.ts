export interface Task {
  id: string
  name: string
  intervalDays: number
  lastDone: string | null // ISO date string
  snoozedUntil: string | null // ISO date string
}
