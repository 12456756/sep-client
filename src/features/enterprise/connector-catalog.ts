import dingtalkLogo from '../../assets/dingtalk.png';
import feishuLogo from '../../assets/feishu.ico';
import type { ConnectorId } from '../../shared/connectors';

export interface ConnectorDefinition {
  id: ConnectorId;
  name: string;
  category: string;
  description: string;
  logoUrl: string;
  capabilities: readonly { name: string; description: string }[];
  authorizationAvailable: boolean;
}

export const CONNECTOR_CATALOG: readonly ConnectorDefinition[] = [
  {
    id: 'feishu', name: '飞书', category: '协同办公', description: '文档、多维表格与团队协作',
    logoUrl: feishuLogo, authorizationAvailable: true,
    capabilities: [
      { name: '文档与知识库', description: '搜索、读取和编辑文档，管理云空间与知识库。' },
      { name: '消息与群聊', description: '搜索和查询消息、管理群聊，按指令发送消息。' },
      { name: '日历与任务', description: '查询日程、安排会议，创建和管理任务。' },
      { name: '多维表格与电子表格', description: '读写记录与单元格，管理数据表、字段和视图。' },
      { name: '云盘与演示文稿', description: '上传、下载和管理文件，读取和编辑演示文稿。' },
      { name: '审批与考勤', description: '查询和处理账号有权访问的审批与考勤业务。' },
      { name: '通讯录与邮箱', description: '查找人员，检索和处理个人邮件。' },
      { name: '会议与 OKR', description: '查询会议与纪要，管理目标及关键结果。' },
    ],
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    category: '协同办公',
    description: '文档、沟通与协同办公',
    logoUrl: dingtalkLogo,
    authorizationAvailable: true,
    capabilities: [
      { name: '文档与知识库', description: '搜索、读取、编辑文档，管理知识库与文档空间。' },
      { name: '群聊与消息', description: '查询会话和消息、管理群聊，按指令发送消息。' },
      { name: '日历与待办', description: '查询和安排日程、会议室，创建和管理待办。' },
      { name: 'OA 审批', description: '查询、发起和处理账号有权操作的审批。' },
      { name: '钉盘', description: '查找、上传、下载和管理文件与文件夹。' },
      { name: 'AI 表格与电子表格', description: '查询和更新记录、字段与单元格，管理表格。' },
      { name: '通讯录与邮箱', description: '查询人员和部门，检索、收取和发送邮件。' },
      { name: '听记与更多业务', description: '访问 AI 听记、考勤、日志、目标管理等已获授权的业务。' },
    ],
  },
];
