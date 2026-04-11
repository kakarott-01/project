"use client"

import { ErrorBoundary } from 'react-error-boundary'
import React from 'react'

function Fallback() {
  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <div className="mt-3">
        <button
          onClick={() => window.location.reload()}
          className="px-3 py-2 rounded-md bg-gray-800 text-sm text-white"
        >
          Reload
        </button>
      </div>
    </div>
  )
}

export default function DashboardErrorBoundary({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary FallbackComponent={Fallback}>{children}</ErrorBoundary>
}
