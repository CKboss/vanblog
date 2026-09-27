import { Select } from 'antd';
import { useIntl } from 'umi';

const optionNum = [3, 5, 7, 10, 15, 30];

/**
 * 🔴 期 6 第十二批：这个组件原来收的是**调用方给的中文字面量**（`d="天"` / `d="条"`），
 * 然后拼成 `近${n}${d}`。那样翻译不了 —— 只翻这个文件的话英文会变成 `Last 3天`（半截中文）。
 * ⇒ 改成收**语义单位键**（`unit="days" | "items"`），文案在这里一次成型（ICU 整句 + 英文 plural），
 *    调用方（Welcome 的三个 tab）跟着改成传键。🔴 这不是"顺手改 API"：不改就必然留下半截中文。
 */
const generateOptions = (
  nums: number[],
  unit: string,
  t: (id: string, defaultMessage: string, values?: Record<string, any>) => string,
) => {
  const res = [];
  nums.forEach((n) => {
    res.push({
      // 🔴 defaultMessage 必须**写在 t() 调用里**（不能从常量表里取）：
      //    库存清点与守卫都是按"t() 的第二个实参"认 defaultMessage 位的，
      //    绕一层变量就会被当成裸中文（实测：`UNIT_DEFAULTS[unit]` 那种写法让本文件多算 2 条）。
      label:
        unit === 'items'
          ? t('common.recentNItems', '近{count}条', { count: n })
          : t('common.recentNDays', '近{count}天', { count: n }),
      value: n,
    });
  });
  return res;
};

export default function (props: {
  value: number;
  setValue: (n: number) => {};
  /** 🔴 语义单位键：`days` / `items`。
   *  ⚠️ 旧 API 是 `d="天"`（调用方给**中文字面量**）⇒ 那样翻译不了（只翻这里英文会变成 `Last 3天`）。
   *  5 个调用点（Welcome 的三个 tab）已一并改成传键，所以这里**不留**中文兼容分支
   *  —— 留了就是把中文字面量重新写回源码（棘轮会红），而且没人会再走那条路。 */
  unit?: string;
}) {
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const unit = props.unit === 'items' ? 'items' : 'days';
  return (
    <Select
      size={'small'}
      value={props.value}
      onChange={(v) => {
        props.setValue(v);
      }}
      options={generateOptions(optionNum, unit, t)}
    />
  );
}
