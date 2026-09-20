import * as React from 'react';
import { Empty } from '../../components/enterprise/atoms';

interface Props {
  onRetry?: () => void;
}

export function OrganizationEmptyState({ onRetry }: Props): React.JSX.Element {
  return (
    <div className="ent-page ent-organization org-unavailable" role="status">
      <Empty title="平台暂无企业成员数据">
        SEP 当前没有返回企业成员或部门数据。请确认企业组织数据已配置后重试。
      </Empty>
      {onRetry ? <button type="button" className="workspace-primary-button" onClick={onRetry}>重新加载</button> : null}
    </div>
  );
}
