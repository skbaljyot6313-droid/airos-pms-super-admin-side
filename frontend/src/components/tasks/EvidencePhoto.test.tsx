import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client';
import { EvidencePhoto, evidencePath } from './EvidencePhoto';
import { CompletionEvidenceLightbox } from './CompletionEvidenceLightbox';

vi.mock('../../api/client', () => ({
  BASE_URL: 'https://api.example.test/api/v1',
  mediaUrl: (url: string) => url.startsWith('/') ? `https://api.example.test${url}` : url,
  apiFetch: vi.fn(),
}));
const one = '/api/v1/media/file/' + 'a'.repeat(32) + '.jpg';
const two = '/api/v1/media/file/' + 'b'.repeat(32) + '.jpg';
const images = [{ image_uid: 'one', url: one }, { image_uid: 'two', url: two }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' }));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:evidence') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 5));
});

describe('evidence delivery and thumbnails', () => {
  it('maps API proxy and legacy uploads without leaking auth to other origins', () => {
    expect(evidencePath(one)).toBe('/media/file/' + 'a'.repeat(32) + '.jpg');
    expect(evidencePath('/uploads/' + 'a'.repeat(32) + '.jpg')).toBe('/media/file/' + 'a'.repeat(32) + '.jpg');
    expect(evidencePath('https://other.example.test' + one)).toBeNull();
  });

  it('loads protected images as authenticated blobs and shows a loading state through decoding', async () => {
    render(<EvidencePhoto src={one} alt="Evidence 1" className="w-24 h-24" />);
    expect(screen.getByRole('status')).toBeTruthy();
    const image = await screen.findByAltText('Evidence 1');
    expect(apiFetch).toHaveBeenCalledWith('/media/file/' + 'a'.repeat(32) + '.jpg', { responseType: 'blob' });
    expect(image.getAttribute('src')).toBe('blob:evidence');
    fireEvent.load(image);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('deduplicates simultaneous thumbnail and preview retrievals and releases blobs', async () => {
    const view = render(<><EvidencePhoto src={one} alt="Thumbnail" /><EvidencePhoto src={one} alt="Preview" /></>);
    await screen.findByAltText('Preview');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    view.unmount();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:evidence'));
  });

  it('shows request failure without a broken image and retries only on request', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('missing'));
    render(<EvidencePhoto src={one} alt="Evidence 1" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
    expect(await screen.findByAltText('Evidence 1')).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('handles unsupported formats and decode failures', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Blob(['invalid'], { type: 'image/heic' }));
    render(<EvidencePhoto src={one} alt="Evidence 1" />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
    fireEvent.error(await screen.findByAltText('Evidence 1'));
    expect(screen.getByRole('alert').textContent).toContain('Image unavailable');
  });

  it('does not show stale content when the source changes', async () => {
    const view = render(<EvidencePhoto src={one} alt="Evidence 1" />);
    await screen.findByAltText('Evidence 1');
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(() => {}));
    view.rerender(<EvidencePhoto src={two} alt="Evidence 2" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('evidence viewer interaction', () => {
  it('renders selected image, navigates both directions and selects thumbnails', async () => {
    render(<CompletionEvidenceLightbox images={images} initialIndex={1} onClose={vi.fn()} />);
    await screen.findByAltText('Completion evidence 2');
    expect(screen.getByText('Image 2 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    await screen.findByAltText('Completion evidence 1');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    await screen.findByAltText('Completion evidence 2');
    fireEvent.click(screen.getByRole('button', { name: 'View image 1' }));
    await screen.findByAltText('Completion evidence 1');
    expect(screen.getByRole('button', { name: 'View image 1' }).className).toContain('border-[#9FBF88]');
  });

  it('supports keyboard controls and distinguishes backdrop from image clicks', async () => {
    const close = vi.fn();
    render(<CompletionEvidenceLightbox images={images} onClose={close} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    const image = await screen.findByAltText('Completion evidence 2');
    fireEvent.click(image);
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await screen.findByAltText('Completion evidence 1');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('restores background scrolling and handles empty evidence without a modal', () => {
    document.body.style.overflow = 'auto';
    const view = render(<CompletionEvidenceLightbox images={images} onClose={vi.fn()} />);
    expect(document.body.style.overflow).toBe('hidden');
    view.unmount();
    expect(document.body.style.overflow).toBe('auto');
    render(<CompletionEvidenceLightbox images={[]} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('resets selection when switching task evidence collections', async () => {
    const view = render(<CompletionEvidenceLightbox images={images} initialIndex={1} onClose={vi.fn()} />);
    await screen.findByAltText('Completion evidence 2');
    view.rerender(<CompletionEvidenceLightbox images={[{ url: '/uploads/' + 'c'.repeat(32) + '.jpg' }]} onClose={vi.fn()} />);
    await screen.findByAltText('Completion evidence 1');
    expect(screen.getByText('Image 1 of 1')).toBeTruthy();
  });
});
