import React from 'react';

interface FormFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  error?: string;
  required?: boolean;
  textarea?: boolean;
  autoComplete?: string;
}

/**
 * Labelled input/textarea with inline error display.
 * Errors render as text — never color-only — for accessibility.
 */
export const FormField: React.FC<FormFieldProps> = ({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  error,
  required = true,
  textarea = false,
  autoComplete,
}) => {
  const inputCls = `w-full px-3.5 py-2.5 bg-[#FFFFFF] border rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020] ${
    error ? 'border-[#D64545]' : 'border-[#D6D3D1]'
  }`;

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1.5 font-body"
      >
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {textarea ? (
        <textarea
          id={id}
          rows={3}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          className={inputCls}
        />
      ) : (
        <input
          id={id}
          type={type}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          className={inputCls}
        />
      )}
      {error && (
        <p id={`${id}-error`} className="text-[11px] text-[#A83434] font-medium mt-1">
          {error}
        </p>
      )}
    </div>
  );
};
