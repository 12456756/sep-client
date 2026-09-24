import { Check, Command, Moon, Search, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppRoute } from "../../features/enterprise/types";
import { useDrawer } from "../../features/enterprise/use-drawer";

interface CommandPaletteProps {
  darkMode: boolean;
  onClose: () => void;
  onNavigate: (route: AppRoute) => void;
  onToggleTheme: () => void;
}

type CommandItem = {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  icon: typeof Search;
  action: () => void;
};

export function CommandPalette({
  darkMode,
  onClose,
  onNavigate,
  onToggleTheme,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const panel = useDrawer(onClose);

  const commands = useMemo<CommandItem[]>(
    () => [
      {
        id: "home",
        label: "个人工作台",
        hint: "查看待处理工作和已订阅员工",
        keywords: "首页 工作台 个人",
        icon: Search,
        action: () => onNavigate({ name: "home" }),
      },
      {
        id: "organization",
        label: "企业组织",
        hint: "查看组织架构和企业成员",
        keywords: "企业 组织 架构 部门",
        icon: Search,
        action: () => onNavigate({ name: "organization" }),
      },
      {
        id: "employees",
        label: "硅基员工",
        hint: "搜索员工、查看能力和状态",
        keywords: "员工 搜索 能力 状态",
        icon: Search,
        action: () => onNavigate({ name: "employees" }),
      },
      {
        id: "arrange",
        label: "安排工作",
        hint: "选择员工并开始一项新工作",
        keywords: "安排 工作 编排 对话",
        icon: Search,
        action: () => onNavigate({ name: "arrange" }),
      },
      {
        id: "records",
        label: "工作记录",
        hint: "优先查看需要你处理的工作",
        keywords: "记录 待处理 工作 历史",
        icon: Search,
        action: () => onNavigate({ name: "records", bucket: "mine" }),
      },
      {
        id: "skills",
        label: "员工技能",
        hint: "查看技能原文和个人版本",
        keywords: "技能 知识 能力",
        icon: Search,
        action: () => onNavigate({ name: "skills" }),
      },
      {
        id: "theme",
        label: darkMode ? "切换到浅色主题" : "切换到深色主题",
        hint: "只影响当前客户端外观",
        keywords: "主题 深色 浅色 外观",
        icon: darkMode ? Sun : Moon,
        action: onToggleTheme,
      },
    ],
    [darkMode, onNavigate, onToggleTheme],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return commands;
    return commands.filter((item) =>
      `${item.label} ${item.hint} ${item.keywords}`
        .toLowerCase()
        .includes(term),
    );
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex((index) =>
      Math.min(index, Math.max(0, filtered.length - 1)),
    );
  }, [filtered.length]);

  const run = (item: CommandItem | undefined) => {
    if (!item) return;
    item.action();
    onClose();
  };

  return (
    <div
      className="ent-command-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="ent-command"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ent-command-title"
        ref={panel}
      >
        <div className="ent-command-search">
          <Search size={17} aria-hidden />
          <input
            value={query}
            placeholder="搜索页面或操作…"
            aria-label="搜索页面或操作"
            aria-controls="ent-command-list"
            aria-activedescendant={filtered[activeIndex] ? `ent-command-option-${filtered[activeIndex].id}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) =>
                  Math.min(index + 1, filtered.length - 1),
                );
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                run(filtered[activeIndex]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="ent-command-heading">
          <strong id="ent-command-title">命令入口</strong>
          <span>快速打开页面，不替代左侧导航</span>
        </div>

        <div id="ent-command-list" className="ent-command-list" role="listbox" aria-label="命令列表" aria-live="polite">
          {filtered.length ? (
            filtered.map((item, index) => {
              const Icon = item.icon;
              const active = index === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  id={`ent-command-option-${item.id}`}
                  role="option"
                  aria-selected={active}
                  className={`ent-command-item${active ? " active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => run(item)}
                >
                  <span className="ent-command-icon">
                    <Icon size={15} aria-hidden />
                  </span>
                  <span className="ent-command-copy">
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                  {active ? <Check size={14} aria-hidden /> : null}
                </button>
              );
            })
          ) : (
            <p className="ent-command-empty">没有匹配的页面或操作</p>
          )}
        </div>

        <footer className="ent-command-foot">
          <span>
            <Command size={12} aria-hidden /> 快捷键
          </span>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>选择
          </span>
          <span>
            <kbd>↵</kbd>打开
          </span>
        </footer>
      </section>
    </div>
  );
}
