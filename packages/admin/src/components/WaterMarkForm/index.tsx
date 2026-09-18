import { getStaticSetting, updateStaticSetting } from '@/services/van-blog/api';
import { ProForm, ProFormDigit, ProFormSelect, ProFormText } from '@ant-design/pro-form';
import { message, Modal } from 'antd';
import { useState } from 'react';
export default function (props: {}) {
  const [enableWaterMark, setEnableWaterMark] = useState<boolean>(false);
  return (
    <>
      <ProForm
        grid={true}
        layout={'horizontal'}
        labelCol={{ span: 6 }}
        request={async (params) => {
          const { data } = await getStaticSetting();
          setEnableWaterMark(data?.enableWaterMark || false);
          if (!data) {
            return {
              enableWaterMark: false,
              enableWebp: true,
              compressFormat: 'webp',
              enableResize: true,
              maxImageEdge: 1920,
              enableThumb: true,
              thumbWidth: 300,
              enableStegoWaterMark: true,
            };
          }
          return {
            ...data,
            compressFormat: data.compressFormat || 'webp',
            enableResize: data.enableResize !== false,
            maxImageEdge: data.maxImageEdge ?? 1920,
            enableThumb: data.enableThumb !== false,
            thumbWidth: data.thumbWidth || 300,
            enableStegoWaterMark: data.enableStegoWaterMark !== false,
          };
        }}
        syncToInitialValues={true}
        onFinish={async (data) => {
          if (location.hostname == 'blog-demo.mereith.com') {
            Modal.info({ title: '演示站禁止修改此配置！' });
            return;
          }
          for (const [k, v] of Object.entries(data)) {
            if (v == 'false') {
              data[k] = false;
            } else if (v == 'true') {
              data[k] = true;
            } else {
              data[k] = v;
            }
          }
          setEnableWaterMark(data?.enableWaterMark || false);
          if (data.enableWaterMark && !data.waterMarkText) {
            Modal.info({ title: '开启水印必须指定水印文字！' });
            return;
          }
          // ⚠️ 这里以前有一道 `checkNoChinese(data.waterMarkText)` 硬拦中文的闸门，
          // 理由是「用了纯 js 库节约资源」（jimp + .fnt 位图字体，确实渲染不了汉字）。
          // 2026-09 渲染整个重写成 sharp/libvips + SVG <text> 之后那个前提不存在了：
          // 服务端按字体栈栅格化，**中文照常能盖**（官方镜像装了 ttf-dejavu + wqy-zenhei），
          // 缺字体时服务端自己会 WARN + 返回原图（宁可不盖也不盖满图豆腐块）。
          // 所以闸门删掉，文案跟着改；服务端行为由 packages/server 的 watermark.spec.ts 钉住。
          const toUpload = data;
          await updateStaticSetting(toUpload);
          message.success('更新成功！');
        }}
      >
        <ProFormSelect
          name="enableWebp"
          label="图片自动压缩"
          request={async () => {
            return [
              {
                label: '开启',
                value: true,
              },
              {
                label: '关闭',
                value: false,
              },
            ];
          }}
          rules={[{ required: true, message: '这是必填项' }]}
          required
          placeholder={'是否开启图片自动压缩'}
          tooltip="开启之后上传图片将压缩为所选格式以提高加载速度，无论哪种存储策略都生效。只影响新上传，不会改写已有文件。"
        />
        <ProFormSelect
          name="compressFormat"
          label="压缩格式"
          request={async () => {
            return [
              {
                label: 'WebP（默认）',
                value: 'webp',
              },
              {
                label: 'AVIF',
                value: 'avif',
              },
            ];
          }}
          rules={[{ required: true, message: '这是必填项' }]}
          required
          placeholder={'选择压缩输出格式'}
          tooltip="仅在开启自动压缩时生效。AVIF 通常比 WebP 更小；现代浏览器已广泛支持。编码优先用 sharp（与前台相同的 0.32.6）；官方 Alpine 镜像若无法加载 musl sharp，则使用 libavif-apps 的 avifenc。"
        />
        <ProFormSelect
          fieldProps={{
            onChange: (target) => {
              setEnableWaterMark(target);
            },
          }}
          name="enableWaterMark"
          required
          label="可见水印"
          placeholder={'是否开启水印'}
          request={async () => {
            return [
              {
                label: '开启',
                value: true,
              },
              {
                label: '关闭',
                value: false,
              },
            ];
          }}
          tooltip={
            '可见的文字水印（默认关闭，很多人嫌它挡图）。开启后上传图片会自动加上，无论哪种图床。默认样式是「满图斜排平铺」（旋转小字，裁不掉），样式与位置由服务端环境变量 VANBLOG_WATERMARK_STYLE / VANBLOG_WATERMARK_POSITION 调，不在本表单里。短边小于 52px 的图会跳过水印（服务端记一条 WARN，图片照常上传）。想要看不出来又能验真的水印，请用下面的「隐写水印」。'
          }
          rules={[{ required: true, message: '这是必填项' }]}
        ></ProFormSelect>
        <ProFormText
          name="waterMarkText"
          label={'可见水印文字'}
          required
          tooltip={
            '水印文字，可包含 .（如域名），支持中文（渲染在服务端做，官方镜像已装 Latin + 中文字体）。文字越长需要的图越大：字号会按图片尺寸自动算，放不下时自动缩小，缩到 8px 还放不下就跳过这一张（记一条 WARN，不影响上传）。'
          }
          placeholder="请输入水印文字"
        />
        <ProFormSelect
          name="enableResize"
          label="大图自动缩放"
          required
          rules={[{ required: true, message: '这是必填项' }]}
          placeholder={'是否缩放过大的图片'}
          request={async () => {
            return [
              { label: '开启', value: true },
              { label: '关闭', value: false },
            ];
          }}
          tooltip="开启后，长边超过下面「长边上限」的图片会在上传时等比缩小（只缩不放，小图不动）。缩放发生在压缩和隐写水印之前，所以水印照样读得出来。只影响新上传的图片。"
        />
        <ProFormDigit
          name="maxImageEdge"
          label="长边上限"
          min={0}
          max={8192}
          fieldProps={{ step: 10, precision: 0 }}
          placeholder="1920"
          tooltip="单位 px。1920 就是常说的 1080p 级；填 0 表示不限制；小于 320 的值会被抬到 320。"
        />
        <ProFormSelect
          name="enableThumb"
          label="生成缩略图"
          required
          rules={[{ required: true, message: '这是必填项' }]}
          placeholder={'是否生成缩略图'}
          request={async () => {
            return [
              { label: '开启', value: true },
              { label: '关闭', value: false },
            ];
          }}
          tooltip="上传时额外生成一张小图（默认 300px 宽的 WebP，约 10KB），「图片管理」列表加载它而不是原图，翻几十张图快得多。存量图片在「图片管理 → 补缩略图」里一次性补齐。"
        />
        <ProFormDigit
          name="thumbWidth"
          label="缩略图宽度"
          min={64}
          max={1024}
          fieldProps={{ step: 10, precision: 0 }}
          placeholder="300"
          tooltip="单位 px，默认 300。改完只影响之后生成的缩略图。"
        />
        <ProFormSelect
          name="enableStegoWaterMark"
          label="隐写水印"
          required
          rules={[{ required: true, message: '这是必填项' }]}
          placeholder={'是否嵌入隐写水印'}
          request={async () => {
            return [
              { label: '开启', value: true },
              { label: '关闭', value: false },
            ];
          }}
          tooltip="把一段文字藏进像素里（每个 8x8 块的亮度最多动 4 个色阶，肉眼看不出来），压成 WebP、被别人另存为 JPEG 之后仍然读得出来。验证方式：图片管理里对着图片右键「检测隐写水印」，或用工具栏「检测水印」上传一张图。注意：图片被缩放或裁剪后就读不出来了；GIF 不处理。"
        />
        <ProFormText
          name="stegoWaterMarkText"
          label="隐写内容"
          tooltip={
            '留空则自动写「域名|上传者|上传时间」，方便追到是谁什么时候传的。最多 200 字节，支持中文；内容越长，需要的图片越大（太小的图会跳过水印，不影响上传）。'
          }
          placeholder="留空使用默认内容"
        />
      </ProForm>
    </>
  );
}
