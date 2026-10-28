import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActiveScreen } from '../types/patchguard';
import { Command, CornerDownLeft, Search } from 'lucide-react';

export interface CommandItem {
  id: string;
  label: string;
  category: 'Navigation' | 'Workspace Action' | 'System & Theme';
  shortcutHint?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (screen: ActiveScreen) => void;
  onLoadIsolatedDemo: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onNavigate,
  onLoadIsolatedDemo,
  theme,
  onToggleTheme,
}) => {
  const [query, setQuery] = useState<string>('');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commands: CommandItem[] = useMemo(
    () => [
      {
        id: 'nav-overview',
        label: 'Open Overview',
        category: 'Navigation',
        shortcutHint: 'G O',
        action: () => onNavigate('overview'),
      },
      {
        id: 'nav-new-review',
        label: 'Start a New Code Review',
        category: 'Workspace Action',
        shortcutHint: 'G N',
        action: () => onNavigate('new-review'),
      },
      {
        id: 'nav-workspace',
        label: 'Open Investigation Review Workspace',
        category: 'Navigation',
        shortcutHint: 'G W',
        action: () => onNavigate('workspace'),
      },
      {
        id: 'action-load-demo',
        label: 'Load Isolated Demonstration Review (PR #418)',
        category: 'Workspace Action',
        action: () => onLoadIsolatedDemo(),
      },
      {
        id: 'nav-history',
        label: 'Open Review History Ledger',
        category: 'Navigation',
        shortcutHint: 'G H',
        action: () => onNavigate('history'),
      },
      {
        id: 'nav-eval-lab',
        label: 'Open Evaluation Lab & Benchmark Suite',
        category: 'Navigation',
        shortcutHint: 'G E',
        action: () => onNavigate('evaluation-lab'),
      },
      {
        id: 'nav-settings',
        label: 'Open System Diagnostics & Settings',
        category: 'System & Theme',
        shortcutHint: 'G S',
        action: () => onNavigate('settings'),
      },
      {
        id: 'action-toggle-theme',
        label: `Switch Theme to ${theme === 'dark' ? 'Light Editorial' : 'Dark Graphite'}`,
        category: 'System & Theme',
        shortcutHint: 'T',
        action: () => onToggleTheme(),
      },
    ],
    [onNavigate, onLoadIsolatedDemo, theme, onToggleTheme]
  );

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
    );
  }, [commands, query]);

  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 10);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Tab' && dialogRef.current) {
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'input, button:not([disabled])'
      );
      if (focusable.length > 0) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredCommands.length > 0 ? (prev + 1) % filteredCommands.length : 0
      );
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredCommands.length > 0
          ? (prev - 1 + filteredCommands.length) % filteredCommands.length
          : 0
      );
      return;
    }
    if (e.key === 'Enter' && filteredCommands[selectedIndex]) {
      e.preventDefault();
      filteredCommands[selectedIndex].action();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center pt-16 sm:pt-24 px-3 sm:px-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="PatchGuard Command Palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="w-full max-w-xl border border-[var(--pg-border-strong)] bg-[var(--pg-bg-surface)] shadow-2xl overflow-hidden"
      >
        {/* Search Input Header */}
        <div className="px-3 sm:px-4 py-3 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center gap-2.5 sm:gap-3">
          <Search className="w-4 h-4 text-[var(--pg-text-muted)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            aria-label="Type a command or search navigation"
            placeholder="Type a command or jump to workspace..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-xs font-mono text-[var(--pg-text-primary)] placeholder:text-[var(--pg-text-muted)] focus:outline-none min-w-0"
          />
          <button
            type="button"
            onClick={onClose}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-[var(--pg-border-default)] text-[var(--pg-text-muted)] hover:text-[var(--pg-text-primary)] cursor-pointer shrink-0"
          >
            ESC
          </button>
        </div>

        {/* Command Items List */}
        <div className="max-h-80 overflow-y-auto divide-y divide-[var(--pg-border-subtle)]">
          {filteredCommands.length === 0 ? (
            <div className="p-6 text-center font-mono text-xs text-[var(--pg-text-muted)]">
              No matching commands for "{query}"
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => {
                    cmd.action();
                    onClose();
                  }}
                  className={`w-full text-left px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2 sm:gap-4 text-xs transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)]'
                      : 'text-[var(--pg-text-primary)] hover:bg-[var(--pg-bg-workspace)]'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2.5 min-w-0">
                    <span className="font-mono text-[10px] text-[var(--pg-text-muted)] uppercase sm:w-28 shrink-0">
                      {cmd.category}
                    </span>
                    <span className="font-medium truncate">{cmd.label}</span>
                  </div>

                  <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--pg-text-muted)] shrink-0">
                    {cmd.shortcutHint && <span>{cmd.shortcutHint}</span>}
                    {isSelected && <CornerDownLeft className="w-3.5 h-3.5 text-[var(--pg-accent-text)]" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-3 sm:px-4 py-2 border-t border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[var(--pg-text-muted)]">
          <span>↑↓ to navigate · Enter to execute · Esc to dismiss</span>
          <span>Cmd/Ctrl + K</span>
        </div>
      </div>
    </div>
  );
};
