import { WorkspaceHomePage } from './WorkspaceHomePage';

async function noOp(): Promise<void> {
  // Browser preview has no Electron session to log out from.
}

export function WorkspacePreviewPage() {
  return <WorkspaceHomePage userName="预览账号" enterpriseName="SEP 示例企业" onLogout={noOp} />;
}
