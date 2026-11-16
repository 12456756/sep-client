import dingtalkLogo from '../../assets/dingtalk.png';
import feishuLogo from '../../assets/feishu.ico';
import wecomLogo from '../../assets/wecom.ico';
import tmeetLogo from '../../assets/tencent-meeting.ico';
import qqMailLogo from '../../assets/qq-mail.ico';
import kdocsLogo from '../../assets/kdocs.png';
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
    id: 'kdocs', name: '金山文档', category: '云文档', description: '云文档检索、编辑与表格读写',
    logoUrl: kdocsLogo, authorizationAvailable: true,
    capabilities: [
      { name: '文档搜索与阅读', description: '搜索和浏览云文档，读取有权访问的文档正文。' },
      { name: '文档创建与编辑', description: '新建文档，向智能文档追加、插入或替换内容。' },
      { name: '文件整理', description: '查询文件信息与链接，重命名、移动和复制文件。' },
      { name: '表格读写', description: '查询工作表，读取选区并更新单元格值或公式。' },
    ],
  },
  {
    id: 'qqmail', name: 'QQ 邮箱', category: '电子邮件', description: '邮件检索、阅读与收发',
    logoUrl: qqMailLogo, authorizationAvailable: true,
    capabilities: [
      { name: '邮件检索', description: '按关键词和未读状态分页查询邮件。' },
      { name: '正文阅读', description: '读取邮件正文及附件名称、大小等信息。' },
      { name: '发送与回复', description: '使用已连接的邮箱发送和回复文本邮件。' },
      { name: '文件夹查询', description: '查看邮箱文件夹与分类。' },
    ],
  },
  {
    id: 'tmeet', name: '腾讯会议', category: '视频会议', description: '会议安排、录制与智能纪要',
    logoUrl: tmeetLogo, authorizationAvailable: true,
    capabilities: [
      { name: '会议查询', description: '查询和搜索当前账号可访问的会议。' },
      { name: '会议安排', description: '创建、修改和取消普通预约会议。' },
      { name: '录制查询', description: '搜索已生成且有权访问的会议录制。' },
      { name: '纪要与转写', description: '读取录制对应的智能纪要和转写内容。' },
    ],
  },
  {
    id: 'wecom', name: '企业微信', category: '协同办公', description: '会话、消息与通讯录',
    logoUrl: wecomLogo, authorizationAvailable: true,
    capabilities: [
      { name: '会话与消息查询', description: '查询本次授权可访问的会话和消息，开放范围以企业策略为准。' },
      { name: '消息发送', description: '按指令发送文本消息，具体身份和可发送对象以官方接口权限为准。' },
      { name: '身份与通讯录', description: '核对当前授权身份，查询有权访问的人员信息。' },
    ],
  },
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
