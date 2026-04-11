"use client";
import { useRef, useState } from 'react'

export function useActionLocks() {
  const lockedActionsRef = useRef<Set<string>>(new Set())
  const [, setTick] = useState(0)

  function lockAction(id: string) {
    lockedActionsRef.current.add(id)
    setTick(n => n + 1)
  }

  function unlockAction(id: string) {
    lockedActionsRef.current.delete(id)
    setTick(n => n + 1)
  }

  function isLocked(id: string) {
    return lockedActionsRef.current.has(id)
  }

  return { lockAction, unlockAction, isLocked }
}
