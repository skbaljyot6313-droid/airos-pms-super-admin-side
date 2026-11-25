/**
 * Login accounts — super_admin only. Every user row in the caller's
 * organization with its role and scoped property.
 */

import { apiFetch } from './client';
import { UserRole } from '../types';

export interface Account {
  account_uid: string;
  name: string;
  username: string;
  email: string;
  phone_number: string | null;
  role: UserRole;
  job_title: string | null;
  property_uid: string | null;
  property_name: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

export async function listAccounts(): Promise<{
  items: Account[];
  total: number;
}> {
  return apiFetch<{ items: Account[]; total: number }>('/accounts');
}
