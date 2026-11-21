import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  BASE_URL: 'http://localhost:8000/api/v1',
  mediaUrl: (url: string) => 'http://localhost:8000' + url,
  apiFetch: vi.fn(async () => new Blob(['image'], { type: 'image/jpeg' })),
}));
beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:evidence'),
    revokeObjectURL: vi.fn(),
  }));
});
import { CompletionEvidenceLightbox } from './CompletionEvidenceLightbox';

const images = [
  { image_uid: 'one', url: '/api/v1/media/file/' + 'a'.repeat(32) + '.jpg' },
  { image_uid: 'two', url: '/api/v1/media/file/' + 'b'.repeat(32) + '.jpg' },
];
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 5));
});

describe('completion evidence recovery', () => {
  it('shows an actionable error rather than a broken image', async () => {
    render(<CompletionEvidenceLightbox images={images} onClose={vi.fn()} />);
    fireEvent.error((await screen.findByAltText('Completion evidence 1')));
    expect(screen.getByRole('alert').textContent).toContain('Evidence image could not be loaded');
    expect(screen.getByRole('button', { name: 'Retry image' })).toBeTruthy();
    expect(screen.queryByAltText('Completion evidence 1')).toBeNull();
  });

  it('retries without modifying stored URLs or deleting evidence', async () => {
    const onDelete = vi.fn();
    render(<CompletionEvidenceLightbox images={images} onClose={vi.fn()} onDelete={onDelete} />);
    const initialSrc = (await screen.findByAltText('Completion evidence 1')).getAttribute('src');
    fireEvent.error((await screen.findByAltText('Completion evidence 1')));
    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((await screen.findByAltText('Completion evidence 1')).getAttribute('src')).toBe(initialSrc);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('keeps other evidence navigable when one file fails', async () => {
    render(<CompletionEvidenceLightbox images={images} onClose={vi.fn()} />);
    fireEvent.error((await screen.findByAltText('Completion evidence 1')));
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect((await screen.findByAltText('Completion evidence 2'))).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
