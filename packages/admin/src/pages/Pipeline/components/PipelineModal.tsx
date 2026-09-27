import { ModalForm, ProFormSelect, ProFormSwitch, ProFormText } from '@ant-design/pro-form';

import { getPipelineConfig, createPipeline, updatePipelineById } from '@/services/van-blog/api';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'umi';
import { Form, message } from 'antd';
export default function ({
  mode,
  trigger,
  initialValues,
  onFinish,
}: {
  mode: 'edit' | 'create';
  trigger: any;
  initialValues?: any;
  onFinish: (vals: any) => void;
}) {
  // 🔴 期 6 第十一批：接上 i18n（语言选择必须在渲染期）。⚠️ `message.*` 是脱离 React 树的独立根（§7.151）。
  // 🔴 t 用 useCallback([intl]) 包成**稳定引用**：下面 useEffect 的依赖数组里要放 t
  //    （回调体用了它，不声明就会闭包住首轮渲染的翻译器 ⇒ 切语言后仍是旧译文；§7.144 B），
  //    而不稳定的 t 会让依赖每轮都变（§7.144 A）。
  const intl = useIntl();
  const t = useCallback(
    (id: string, defaultMessage: string, values?: Record<string, any>) =>
      intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  const isEdit = mode === 'edit';
  const [des, setDes] = useState<string>(t('pipeline.selectEventHint', '选择触发事件后讲展示详情'));
  const [config, setConfig] = useState<any[]>([]);

  const check = (vals: any) => {
    const keys = Object.keys(vals);
    const mustKeys = ['name', 'description', 'eventName', 'enabled'];
    for (let i = 0; i < mustKeys.length; i++) {
      if (!keys.includes(mustKeys[i])) {
        return false;
      }
    }
    return true;
  };

  useEffect(() => {
    if (!initialValues || !initialValues.eventName) return;
    const targetDes = config.find((item) => item.eventName === initialValues.eventName)
      ?.eventDescription;
    setDes(targetDes || t('pipeline.selectEventHint', '选择触发事件后讲展示详情'));
    // 🔴 依赖数组带 t：这个 effect 会把事件说明写进 state（setDes），
    //    不带 t 的话切语言后那段说明仍是旧译文（state 里存的是**算好的字符串**）。
  }, [initialValues, config, t]);

  return (
    <ModalForm
      trigger={trigger}
      onFinish={async (vals) => {
        console.log(vals);
        if (!check(vals)) {
          message.error(t('pipeline.fillAllFields', '请填写完整信息后提交！'));
          return false;
        } else {
          if (mode == 'create') {
            await createPipeline(vals);
            message.success(t('common.submitSuccess', '提交成功！'));
            onFinish(vals);
            return true;
          } else {
            await updatePipelineById(initialValues.id, vals);
            message.success(t('common.submitSuccess', '提交成功！'));
            onFinish(vals);
            return true;
          }
        }
      }}
      layout="horizontal"
      labelCol={{ span: 4 }}
      initialValues={isEdit ? { ...initialValues } : { enabled: false }}
      autoFocusFirstInput
      title={isEdit ? t('pipeline.editTitle', '修改流水线') : t('pipeline.createTitle', '创建流水线')}
    >
      <ProFormText name="name" label={t('common.colName', '名称')} required />
      <ProFormText name="description" label={t('theme.fieldDescription', '描述')} required tooltip={t('pipeline.descriptionPlaceholder', '给自己写的，防止忘了')} />
      <ProFormSelect
        name="eventName"
        label={t('log.colTriggerEvent', '触发事件')}
        tooltip={t('pipeline.eventPlaceholder', '选择后可以看到事件的说明')}
        required
        request={async () => {
          const { data } = await getPipelineConfig();
          setConfig(data);
          return data?.map((item) => ({
            label: item.eventNameChinese,
            value: item.eventName,
          }));
        }}
        fieldProps={{
          onChange: (val) => {
            const targetDes = config.find((item) => item.eventName === val)?.eventDescription;
            setDes(targetDes || t('pipeline.selectEventHint', '选择触发事件后讲展示详情'));
          },
        }}
      />
      <Form.Item label={t('pipeline.eventDetail', '事件说明')}>
        <div>{des}</div>
      </Form.Item>
      <ProFormSwitch name="enabled" label={t('comment.colStatus', '状态')} required />
      <ProFormSelect
        name="deps"
        label={t('pipeline.depsLabel', '依赖')}
        tooltip={t('pipeline.depsTooltip', '依赖是 nodejs 包名，可以输入多个，将通过 pnpm install <依赖名> 来依次安装')}
        mode="tags"
        placeholder={t('pipeline.depsPlaceholder', '请输入依赖')}
      />
    </ModalForm>
  );
}
