import { apiFetch } from './client';
import { Section } from '../types';
import { SectionCreateRequest, SectionUpdateRequest, ListResponse } from './types';

export async function listSections(property_uid?: string): Promise<ListResponse<Section>> {
  return apiFetch<ListResponse<Section>>('/sections', { query: { property_uid } });
}

export async function createSection(req: SectionCreateRequest): Promise<Section> {
  return apiFetch<Section>('/sections', { method: 'POST', body: req });
}

export async function updateSection(section_uid: string, req: SectionUpdateRequest): Promise<Section> {
  return apiFetch<Section>(`/sections/${section_uid}`, { method: 'PATCH', body: req });
}

export async function deleteSection(section_uid: string): Promise<void> {
  return apiFetch<void>(`/sections/${section_uid}`, { method: 'DELETE' });
}
