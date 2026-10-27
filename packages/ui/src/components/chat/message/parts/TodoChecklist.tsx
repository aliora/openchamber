import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { ToolPart } from '@/lib/opencode/model';
import { todoItems, type TodoItem } from '@/lib/opencode/tools';
import { cn } from '@/lib/utils';

const ROW_ICON: Record<TodoItem['status'], IconName> = {
    completed: 'checkbox-circle',
    in_progress: 'record-circle',
    pending: 'circle',
};

interface TodoChecklistProps {
    part: ToolPart;
}

const TodoChecklist: React.FC<TodoChecklistProps> = ({ part }) => {
    const items = todoItems(part.state.input);
    if (items.length === 0) return null;
    const done = items.filter((item) => item.status === 'completed').length;

    return (
        <div className="my-1 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3 py-2" data-testid="todo-checklist">
            <div className="mb-1 flex items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name="checkbox-multiple" className="h-3.5 w-3.5" />
                <span className="tabular-nums">{done}/{items.length}</span>
            </div>
            <ul className="flex flex-col gap-0.5">
                {items.map((item, index) => (
                    <li
                        key={`${index}-${item.content}`}
                        data-status={item.status}
                        className={cn(
                            'flex items-start gap-2 typography-meta',
                            item.status === 'completed' && 'text-muted-foreground line-through',
                            item.status === 'in_progress' && 'font-medium text-foreground',
                            item.status === 'pending' && 'text-foreground/80',
                        )}
                    >
                        <Icon
                            name={ROW_ICON[item.status]}
                            className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
                            style={item.status === 'completed' ? { color: 'var(--status-success)' } : undefined}
                        />
                        <span className="min-w-0 break-words">{item.status === 'in_progress' ? item.activeForm ?? item.content : item.content}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
};

export default TodoChecklist;
