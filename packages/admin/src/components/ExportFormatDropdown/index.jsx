import { Dropdown, Menu } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { downloadMarkdownExport } from '@/services/van-blog/exportMarkdown';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EXPORT_FORMATS } = require('@/services/van-blog/exportFormats');

/**
 * 「导出」下拉：md / mdz / zip 三选一。
 *
 * 为什么要这个组件：以前列表里那个「导出」是一个 `<a onClick>`，**永远**回一个外层 zip。
 * 现在把格式选择显式化，并且每一项都带一句代价说明 —— 选错格式的代价（.md 不含图片、
 * .mdz 在无图文章上会被服务端拒绝）必须在选择的那一刻就看得见，而不是等下载完才发现。
 *
 * ⚠️ 用 antd 4 的 `overlay` + `<Menu>` 写法，不是 antd 5 的 `menu={{ items }}`
 * （本仓库后台仍是 antd 4.24，混用会静默不渲染）。
 */
export default function ExportFormatDropdown({ payload, text = '导出', ...rest }) {
  const overlay = (
    <Menu
      onClick={({ key }) => {
        // key 就是格式名（md / mdz / zip），由 EXPORT_FORMATS 生成，不需要再映射一次
        downloadMarkdownExport({ ...(payload || {}), format: key });
      }}
    >
      {EXPORT_FORMATS.map((f) => (
        <Menu.Item key={f.key} title={f.hint}>
          <div>
            <div>{f.label}</div>
            <div style={{ fontSize: 12, color: '#999' }}>{f.hint}</div>
          </div>
        </Menu.Item>
      ))}
    </Menu>
  );
  return (
    <Dropdown overlay={overlay} trigger={['click']} {...rest}>
      <a onClick={(e) => e.preventDefault()}>
        {text} <DownOutlined style={{ fontSize: 10 }} />
      </a>
    </Dropdown>
  );
}
