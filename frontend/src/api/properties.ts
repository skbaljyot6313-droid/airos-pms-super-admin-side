import { apiFetch } from './client';
import { Property } from '../types';
import { ListResponse, PropertyCreateRequest, PropertyUpdateRequest } from './types';

export interface PropertyListParams {
  search?: string;
  status?: Property['status'];
  page?: number;
  limit?: number;
}

/** Properties scoped to the caller's company (backend enforces tenancy). */
export async function listProperties(
  params: PropertyListParams = {}
): Promise<ListResponse<Property>> {
  return apiFetch<ListResponse<Property>>('/properties', { query: params });
}

export async function getProperty(property_uid: string): Promise<Property> {
  return apiFetch<Property>(`/properties/${property_uid}`);
}

export async function createProperty(req: PropertyCreateRequest): Promise<Property> {
  return apiFetch<Property>('/properties', { method: 'POST', body: req });
}

export async function updateProperty(
  property_uid: string,
  req: PropertyUpdateRequest
): Promise<Property> {
  return apiFetch<Property>(`/properties/${property_uid}`, { method: 'PATCH', body: req });
}

export async function deleteProperty(property_uid: string): Promise<void> {
  return apiFetch<void>(`/properties/${property_uid}`, { method: 'DELETE' });
}

export interface FreshDayResult {
  tasks_abandoned: number;
  released: {
    rooms: number;
    dorms: number;
    beds: number;
    washrooms: number;
    fixtures: number;
  };
  /** Units a blocking maintenance ticket still holds (kept on maintenance). */
  still_blocked: string[];
}

/**
 * 'Fresh day' — abandons every open task in the property and releases all
 * unblocked cleaning/maintenance units to Available. Occupied stays occupied.
 */
export async function freshDay(property_uid: string): Promise<FreshDayResult> {
  return apiFetch<FreshDayResult>(`/properties/${property_uid}/fresh-day`, {
    method: 'POST',
  });
}
