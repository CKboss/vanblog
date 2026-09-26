import { Button, message } from 'antd';
import { useIntl } from 'umi';

import { getClipboardContents } from '@/services/van-blog/clipboard';

export interface CopyUploadBtnProps {
  url: string;
  accept: string;
  text: string;
  setLoading: (loading: boolean) => void;
  onFinish: (data: unknown) => void;
  onError: () => void;
}

export default function (props: CopyUploadBtnProps) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。这里弹的是 `message.*` —— 它渲染进
  //    **脱离 React 树的独立根**（§7.151 那条实测缺陷）⇒ 传进去的必须是**这里算好的字符串**，
  //    不能塞一个自己调 useIntl 的组件进去。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const handleClick = async () => {
    props.setLoading(true);

    const fileObj = await getClipboardContents();

    if (!fileObj) {
      props.setLoading(false);
      props.onError();
      return;
    }
    const formData = new FormData();

    formData.append('file', fileObj);

    return fetch('/api/admin/img/upload?withWaterMark=true', {
      method: 'POST',
      headers: {
        token: localStorage.getItem('token') || 'null',
      },
      body: formData,
    })
      .then((res) => res.json())
      .then(({ statusCode, data }) => {
        if (statusCode === 200) {
          props?.onFinish(data);
        } else {
          message.error(t('common.uploadFailed', '上传失败！'));
        }
      })
      .catch(() => {
        message.error(t('common.uploadFailed', '上传失败！'));
      })
      .finally(() => {
        props.setLoading(false);
      });
  };

  return (
    <div>
      <Button onClick={handleClick} type="primary">
        {props.text}
      </Button>
    </div>
  );
}
