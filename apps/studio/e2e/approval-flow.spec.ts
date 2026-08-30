import { expect, test, type Page } from "@playwright/test";

const changeReason = "Create reviewed domain-neutral person";
const employeeNumber = "E2E-APPROVAL-001";
const displayName = "审批流程测试人员";

async function openPersonForm(page: Page): Promise<void> {
  await page.getByRole("link", { name: "组织" }).click();
  await expect(page.getByRole("heading", { name: "组织与人员" })).toBeVisible();
  await page.getByRole("button", { name: "新建人员" }).click();
  await page.getByLabel(/工号/u).fill(employeeNumber);
  await page.getByLabel(/姓名/u).fill(displayName);
}

test("request, review, consume, and audit-facing approval state", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "prism-test-principal",
      value: "author",
      url: "http://127.0.0.1:4173",
    },
  ]);
  await page.goto("/");
  await openPersonForm(page);

  let promptIndex = 0;
  page.on("dialog", async (dialog) => {
    if (dialog.type() !== "prompt") throw new Error(`Unexpected dialog: ${dialog.type()}`);
    await dialog.accept(promptIndex++ === 0 ? changeReason : "");
  });
  await page.getByRole("button", { name: "保存" }).click();
  const requestMessage = page.getByText(/审批请求已创建：/u);
  await expect(requestMessage).toBeVisible();
  const requestText = await requestMessage.textContent();
  const approvalId = requestText?.match(/[A-Za-z0-9_-]{8,}/u)?.[0];
  if (!approvalId) throw new Error("Approval ID was not rendered");
  page.removeAllListeners("dialog");

  await page.getByRole("link", { name: "变更审批" }).click();
  await expect(page.locator("main.approval-page h1")).toHaveText("变更审批");
  await context.addCookies([
    {
      name: "prism-test-principal",
      value: "reviewer",
      url: "http://127.0.0.1:4173",
    },
  ]);
  const card = page.locator(".approval-card").filter({ hasText: approvalId });
  await expect(card).toContainText("PENDING");
  page.once("dialog", (dialog) => dialog.accept("Reviewed exact person creation"));
  await card.getByRole("button", { name: "批准" }).click();
  await page.getByLabel("审批状态").selectOption("APPROVED");
  await expect(
    page.locator(".approval-card").filter({ hasText: approvalId }),
  ).toContainText("APPROVED");

  await context.addCookies([
    {
      name: "prism-test-principal",
      value: "publisher",
      url: "http://127.0.0.1:4173",
    },
  ]);
  await openPersonForm(page);
  promptIndex = 0;
  page.on("dialog", async (dialog) => {
    if (dialog.type() !== "prompt") throw new Error(`Unexpected dialog: ${dialog.type()}`);
    await dialog.accept(promptIndex++ === 0 ? changeReason : approvalId);
  });
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("row", { name: new RegExp(displayName, "u") })).toBeVisible();
  page.removeAllListeners("dialog");

  await page.getByRole("link", { name: "变更审批" }).click();
  await page.getByLabel("审批状态").selectOption("CONSUMED");
  const consumed = page.locator(".approval-card").filter({ hasText: approvalId });
  await expect(consumed).toContainText("CONSUMED");
  await expect(consumed).toContainText("SUCCEEDED");
  await expect(consumed).toContainText("publisher");
});
