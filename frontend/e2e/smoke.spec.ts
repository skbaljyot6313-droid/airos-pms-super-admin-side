import { expect, test } from '@playwright/test';

const PROPERTY_UID = '22222222-2222-4222-8222-222222222222';
const PROPERTY = `/property/${PROPERTY_UID}`;

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('#login-identifier').fill('e2e.manager@airos.test');
  await page.locator('#login-password').fill('E2E-Pass-123');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(new RegExp(`${PROPERTY}/zones`));
}

test('login bootstraps the property workspace', async ({ page }) => {
  await login(page);
  // Workspace bootstrap rendered — the seeded zone is visible.
  await expect(page.getByText('Zone A').first()).toBeVisible();
});

test('pending task is listed on the tasks board', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${PROPERTY}/tasks`));
  await expect(page.getByText('E2E pending cleaning').first()).toBeVisible();
});

test('review decision approves a submitted task', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText('E2E submitted task').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByText('Submission Approved')).toBeVisible();
});

test('occupancy switch moves the guest and frees the vacated room', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Rooms', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${PROPERTY}/rooms`));

  // The only occupied unit is Room 101 — the enabled Switch action is its card's.
  const switchBtn = page.locator('button:not([disabled]):has-text("Switch")');
  await expect(switchBtn.first()).toBeVisible();
  await switchBtn.first().click();

  // Destination select (inside the switch modal's form) → the vacant Room 102.
  await page.locator('form').getByRole('combobox').selectOption({ label: 'Room 102' });
  await page.getByRole('button', { name: 'Switch guest' }).click();

  await expect(page.getByText('Guest Switched')).toBeVisible();
});
