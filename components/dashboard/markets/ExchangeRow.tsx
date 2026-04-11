"use client";
import React, { useState } from "react";
import { ChevronUp, Plus, ExternalLink } from "lucide-react";
import type { RevealedKeys } from '@/lib/hooks/use-exchange-otp'
import ConnectedCard from './ConnectedCard';
import ExchangeForm from './ExchangeForm';

interface ExchangeRowProps {
  exch: { id: string; name: string; fields: string[]; docs: string };
  market: { id: string };
  saved: boolean;
  userEmail: string;
  botActiveForMarket: boolean;
  editingKey: string | null;
  editPrefill: RevealedKeys | null;
  onEdit: () => void;
  onSaved: () => void;
  onCancelEdit: () => void;
  onEditOtpModal: () => void;
}

export default function ExchangeRow({
  exch, market, saved, userEmail, botActiveForMarket,
  editingKey, editPrefill, onEdit, onSaved, onCancelEdit, onEditOtpModal,
}: ExchangeRowProps) {
  const key = `${market.id}_${exch.id}`;
  const isEditing = editingKey === key;
  const [formOpen, setFormOpen] = useState(false);

  if (isEditing) {
    return (
      <ExchangeForm
        exch={exch}
        marketId={market.id}
        prefill={editPrefill}
        isEdit
        onSaved={() => { onSaved(); setFormOpen(false); }}
        onCancel={() => { onCancelEdit(); setFormOpen(false); }}
      />
    );
  }

  if (saved) {
    return (
      <ConnectedCard
        exch={exch}
        market={market}
        userEmail={userEmail}
        botActiveForMarket={botActiveForMarket}
        onEdit={onEditOtpModal}
      />
    );
  }

  return (
    <div className="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
      <button
        onClick={() => setFormOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/60 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-4 h-4 rounded-full border-2 border-gray-600 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-400">{exch.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={exch.docs}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-xs text-gray-600 hover:text-brand-500 flex items-center gap-1 transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> Docs
          </a>
          <div className="flex items-center gap-1 text-xs text-gray-500">
            {formOpen ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <><Plus className="w-3.5 h-3.5" /> Connect</>
            )}
          </div>
        </div>
      </button>

      {formOpen && (
        <div className="border-t border-gray-700/40">
          <ExchangeForm
            exch={exch}
            marketId={market.id}
            prefill={null}
            onSaved={() => { setFormOpen(false); onSaved(); }}
            onCancel={() => setFormOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
