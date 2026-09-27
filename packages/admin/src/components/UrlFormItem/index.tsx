import { errorImg } from '@/pages/Static/img';
import { getImgLink } from '@/pages/Static/img/tools';
import { ProFormText } from '@ant-design/pro-form';
import { Image, message } from 'antd';
// 按需引入：`from 'lodash'` 是桶式导入，会把整个 lodash 拖进这个 chunk
import debounce from 'lodash/debounce';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'umi';
import UploadBtn from '../UploadBtn';

export default function (props: {
  name: string;
  label: string;
  placeholder: string;
  required: boolean;
  formRef: any;
  isInit: boolean;
  isFavicon?: boolean;
}) {
  // 🔴 期 6 第八批：这个通用图片 URL 字段（站点 logo / favicon 等都用它）接上 i18n。
  //    🔴 它是被**活体探针**抓出来的：en-US 下系统设置页仍有一条中文 tooltip「上传之前需要设置好图床哦…」，
  //    而棘轮清单里它一直挂着预算 —— 说明"清单上有、但不在当前批次目标文件里"的东西必须靠活体兜住。
  //    ⚠️ `message.*` 是脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const [url, setUrl] = useState('');
  const handleOnChange = debounce((ev) => {
    const val = ev?.target?.value;
    if (val && val != url) {
      setUrl(val);
    }
  }, 500);
  useEffect(() => {
    if (props.formRef && props.formRef.getFieldValue) {
      const src = props.formRef.getFieldValue(props.name);
      setUrl(src);
    }
    if (props.formRef?.current?.getFieldValue) {
      const src = props.formRef.current.getFieldValue(props.name);
      setUrl(src);
    }
  }, [props, setUrl]);
  const dest = useMemo(() => {
    let r = props.isInit ? '/api/admin/init/upload' : '/api/admin/img/upload';
    if (props.isFavicon) {
      r = r + '?favicon=true';
    }
    return r;
  }, [props]);
  return (
    <>
      <ProFormText
        name={props.name}
        label={props.label}
        required={props.required}
        placeholder={props.placeholder}
        tooltip={t('urlForm.imgTooltip', '上传之前需要设置好图床哦，默认为本地图床。')}
        fieldProps={{
          onChange: handleOnChange,
        }}
        extra={
          <div style={{ display: 'flex', marginTop: '10px' }}>
            <Image src={url || ''} fallback={errorImg} height={100} width={100} />
            <div style={{ marginLeft: 10 }}>
              <UploadBtn
                setLoading={() => {}}
                muti={false}
                crop={true}
                text={t('img.uploadBtn', '上传图片')}
                onFinish={(info) => {
                  if (info?.response?.data?.isNew) {
                    message.success(t('common.uploadOkWithName', '{name} 上传成功!', { name: info.name }));
                  } else {
                    message.warning(t('urlForm.existsWithName', '{name} 已存在!', { name: info.name }));
                  }
                  const src = getImgLink(info?.response?.data?.src);
                  setUrl(src);
                  if (props?.formRef?.setFieldsValue) {
                    const oldVal = props.formRef.getFieldsValue();
                    props?.formRef?.setFieldsValue({
                      ...oldVal,
                      [props.name]: src,
                    });
                  }
                  if (props.formRef?.current?.setFieldsValue) {
                    const oldVal = props.formRef.current.getFieldsValue();
                    props?.formRef?.current.setFieldsValue({
                      ...oldVal,
                      [props.name]: src,
                    });
                  }
                }}
                url={dest}
                accept=".png,.jpg,.jpeg,.webp,.avif,.jiff,.gif"
              />
            </div>
          </div>
        }
        rules={props.required ? [{ required: true, message: t('init.field.required', '这是必填项') }] : undefined}
      />
    </>
  );
}
