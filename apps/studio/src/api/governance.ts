import { api } from "./client";
import type { ApprovalTarget, ChangeApproval } from "./types";

export type ApprovalResolution =
  | { readonly status: "approved"; readonly approvalId: string }
  | { readonly status: "requested"; readonly approval: ChangeApproval };

export async function resolveApproval(
  target: ApprovalTarget,
  reason: string,
): Promise<ApprovalResolution> {
  const approvalId = window
    .prompt(
      "输入已批准的Approval ID；留空将创建审批请求并停止当前操作。发布者必须使用相同变更原因。",
    )
    ?.trim();
  if (approvalId) return { status: "approved", approvalId };
  const approval = await api.requestApproval(target, reason);
  return { status: "requested", approval };
}
