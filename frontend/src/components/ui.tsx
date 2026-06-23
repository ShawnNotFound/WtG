/**
 * shared ui primitives for consistent styling across the app.
 * light modern theme with indigo accent color.
 */

import React, { useEffect, useId, useRef, useState } from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  padding?: 'sm' | 'md' | 'lg';
}

const PADDING = { sm: 'p-3', md: 'p-4', lg: 'p-6' };

export function Card({ children, className = '', padding = 'md', ...props }: CardProps) {
  return (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-100 ${PADDING[padding]} ${className}`} {...props}>
      {children}
    </div>
  );
}

interface SectionTitleProps {
  children: React.ReactNode;
  count?: number;
  className?: string;
}

export function SectionTitle({ children, count, className = '' }: SectionTitleProps) {
  return (
    <div className={`flex items-center justify-between mb-3 ${className}`}>
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        {children}
      </h3>
      {count !== undefined && (
        <span className="text-xs text-gray-400">{count}</span>
      )}
    </div>
  );
}

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'green' | 'blue' | 'purple' | 'yellow' | 'red';
  className?: string;
}

const BADGE_COLORS = {
  default: 'bg-gray-100 text-gray-700',
  green: 'bg-emerald-50 text-emerald-700',
  blue: 'bg-blue-50 text-blue-700',
  purple: 'bg-violet-50 text-violet-700',
  yellow: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
};

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${BADGE_COLORS[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const base = 'inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-400';

  const variants = {
    primary: disabled
      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
      : 'bg-indigo-600 hover:bg-indigo-700 text-white',
    secondary: disabled
      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
      : 'bg-gray-100 hover:bg-gray-200 text-gray-700',
    ghost: disabled
      ? 'text-gray-300 cursor-not-allowed'
      : 'text-gray-600 hover:bg-gray-100',
  };

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${fullWidth ? 'w-full' : ''} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}

export interface DropdownOption {
  label: string;
  value: string;
}

interface DropdownSelectProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
}

export function DropdownSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  buttonClassName = '',
  menuClassName = '',
  size = 'md',
  disabled = false,
  title,
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const isDisabled = disabled || options.length === 0;
  const sizeClass = size === 'sm' ? 'px-2 py-1.5' : 'px-3 py-2';

  useEffect(() => {
    if (!open) return;

    setActiveIndex(selectedIndex);

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open, selectedIndex]);

  const chooseOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const moveActive = (delta: number) => {
    if (options.length === 0) return;
    setActiveIndex((current) => (current + delta + options.length) % options.length);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        moveActive(1);
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        moveActive(-1);
      }
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) {
        chooseOption(activeIndex);
      } else {
        setOpen(true);
        setActiveIndex(selectedIndex);
      }
      return;
    }

    if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative w-full ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        disabled={isDisabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => !isDisabled && setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 ${sizeClass} text-left text-sm text-gray-900 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 ${buttonClassName}`}
      >
        <span className="truncate">{selectedOption?.label ?? 'Select'}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && !isDisabled && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg ring-1 ring-black/5 ${menuClassName}`}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            const active = index === activeIndex;

            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => chooseOption(index)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${
                  selected
                    ? 'bg-indigo-600 text-white'
                    : active
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {selected && (
                  <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0">
                    <path d="M4.5 10.5 8 14 15.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
