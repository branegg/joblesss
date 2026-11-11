import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

function inTwoDays(hour: string, days = 2): string {
  const day = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${hour}`;
}

test("shows a sent application and lets you book, move and remove a call", async ({ page }) => {
  await page.goto("/applications");
  if (!(await page.getByLabel("Company").isVisible())) await page.getByText("Add an application", { exact: true }).click();
  await page.getByLabel("Company").fill("Hooli");
  await page.getByLabel("Role").fill("Staff Engineer");
  await page.getByLabel("Where it is now").selectOption("submitted");
  await page.getByRole("button", { name: "Add application" }).click();
  await expect(page).toHaveURL(/\/applications\/\d+$/);

  await page.getByRole("link", { name: "Where things stand" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Where things stand");
  const row = page.getByRole("row").filter({ hasText: "Hooli" });
  await expect(row.getByRole("cell").nth(2)).toHaveText("Applied");
  await expect(row.getByRole("cell").nth(3)).toContainText("—");
  await expect(row.getByRole("cell").nth(4)).toHaveText("no reply yet");

  await row.getByText("Add a call").click();
  await row.getByLabel("Call time").fill(inTwoDays("15:00"));
  await row.getByRole("button", { name: "Save call" }).click();
  await expect(row.getByRole("cell").nth(3)).toContainText(/Booked · \w{3} \d{1,2} \w{3}, 15:00/);

  await row.getByText("Change call").click();
  await row.getByLabel("Call time").fill(inTwoDays("16:30"));
  await row.getByRole("button", { name: "Save call" }).click();
  await expect(row.getByRole("cell").nth(3)).toContainText(/Booked · .*16:30/);

  await row.getByText("Change call").click();
  await row.getByRole("button", { name: "Remove call" }).click();
  await expect(row.getByRole("cell").nth(3)).toContainText("—");
  await expect(row.getByRole("cell").nth(3)).not.toContainText("Booked");

  await row.getByText("Add a call").click();
  await row.getByLabel("Call time").fill(inTwoDays("11:00", -2));
  await row.getByRole("button", { name: "Save call" }).click();
  await expect(row.getByRole("cell").nth(3)).toContainText(/Had · \d{1,2} \w{3}/);
  await row.getByText("Add a call").click();
  await row.getByRole("button", { name: "Remove call" }).click();
  await expect(row.getByRole("cell").nth(3)).not.toContainText("Had");
});
