import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';

interface LogEntry {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: number;
}

interface ClaudeInstallConsoleProps {
  active: boolean;
  onClose?: () => void;
}

export const ClaudeInstallConsole: React.FC<ClaudeInstallConsoleProps> = ({ active, onClose }) => {
  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [status, setStatus] = React.useState<'idle' | 'installing' | 'completed' | 'failed'>('idle');
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!active) return;
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;

    const source = new EventSource('/api/engine/install/stream');

    source.addEventListener('log', (event) => {
      try {
        const data = JSON.parse(event.data);
        setLogs((prev) => [...prev, data]);
      } catch {
        // Ignore parse error
      }
    });

    source.addEventListener('status', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.state) {
          setStatus(data.state);
        }
      } catch {
        // Ignore parse error
      }
    });

    return () => {
      source.close();
    };
  }, [active]);

  React.useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs]);

  if (!active && logs.length === 0) return null;

  return (
    <div className="mt-6 w-full max-w-lg overflow-hidden rounded-lg border border-border bg-black/90 text-left font-mono text-xs shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-border/40 bg-zinc-900/80 px-3 py-2 text-zinc-400">
        <div className="flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-semibold text-zinc-200">Terminal: npm install -g @anthropic-ai/claude-code</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-300">
            {status}
          </span>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="size-5 p-0 text-zinc-400 hover:text-zinc-100"
              onClick={onClose}
              title="Close console"
            >
              <Icon name="close" className="size-3" />
            </Button>
          )}
        </div>
      </div>
      <div
        ref={scrollContainerRef}
        className="max-h-56 min-h-[120px] overflow-y-auto p-3 text-zinc-300 selection:bg-zinc-700 selection:text-white"
      >
        {logs.length === 0 ? (
          <p className="text-zinc-500 italic">Waiting for official package installer to begin...</p>
        ) : (
          logs.map((entry, idx) => {
            const isErr = entry.stream === 'stderr';
            const isSys = entry.stream === 'system';
            return (
              <pre
                key={idx}
                className={`whitespace-pre-wrap break-all ${
                  isErr
                    ? 'text-amber-400'
                    : isSys
                    ? 'text-sky-400 font-semibold'
                    : 'text-zinc-200'
                }`}
              >
                {entry.text}
              </pre>
            );
          })
        )}
      </div>
    </div>
  );
};
