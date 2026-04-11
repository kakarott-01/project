"use client";
import React from 'react'

export default function MarketButton({ children, className, disabled, onClick }: any) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={className}
    >
      {children}
    </button>
  )
}
