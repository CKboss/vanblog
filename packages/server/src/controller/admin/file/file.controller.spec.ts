import { BadRequestException } from '@nestjs/common';
import { FileController, withDisplayName } from './file.controller';
import { config } from 'src/config';

const SIGN = 'b'.repeat(32);

function createController(overrides: Record<string, any> = {}) {
  const staticProvider = {
    upload: jest.fn(async () => ({ src: `/static/file/${SIGN}.x.pdf`, isNew: true, name: 'x.pdf' })),
    getAll: jest.fn(async () => [{ sign: SIGN, name: `${SIGN}.x.pdf`, realPath: '/static/file/x' }]),
    getByOption: jest.fn(async () => ({ total: 1, data: [] })),
    exportAllAttachments: jest.fn(async () => '/static/export/export-file-2026-09-12.zip'),
    deleteOneBySign: jest.fn(async () => ({ deletedCount: 1 })),
    ...overrides,
  };
  return {
    controller: new FileController(staticProvider as any),
    staticProvider,
  };
}

describe('withDisplayName', () => {
  it('strips the hash prefix for plain records', () => {
    expect(withDisplayName({ sign: SIGN, name: `${SIGN}.年度报告.pdf` })).toEqual({
      sign: SIGN,
      name: `${SIGN}.年度报告.pdf`,
      displayName: '年度报告.pdf',
    });
  });

  it('unwraps mongoose documents before spreading them', () => {
    // mongoose 文档的字段在原型上，直接展开会得到空对象
    const doc: any = {
      toObject: () => ({ sign: SIGN, name: `${SIGN}.notes.txt`, realPath: '/static/file/n' }),
      sign: undefined,
    };
    const res = withDisplayName(doc);
    expect(res.sign).toBe(SIGN);
    expect(res.displayName).toBe('notes.txt');
  });
});

describe('FileController', () => {
  const originalDemo = config.demo;

  afterEach(() => {
    config.demo = originalDemo;
  });

  it('uploads through the static provider as staticType "file"', async () => {
    const { controller, staticProvider } = createController();
    const file = { originalname: 'x.pdf', buffer: Buffer.from('pdf') };

    const res: any = await controller.upload(file);

    expect(staticProvider.upload).toHaveBeenCalledWith(file, 'file');
    expect(res.statusCode).toBe(200);
    expect(res.data.src).toBe(`/static/file/${SIGN}.x.pdf`);
  });

  it('rejects an upload without a file', async () => {
    const { controller, staticProvider } = createController();

    await expect(controller.upload(undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(staticProvider.upload).not.toHaveBeenCalled();
  });

  it('lists attachments with paging and an optional name filter', async () => {
    const { controller, staticProvider } = createController();

    await controller.getByOption(2, 20, 'report');

    expect(staticProvider.getByOption).toHaveBeenCalledWith({
      page: 2,
      pageSize: 20,
      staticType: 'file',
      view: 'public',
      name: 'report',
    });
  });

  it('exports every attachment as a zip path', async () => {
    const { controller } = createController();

    const res: any = await controller.exportAllAttachments();

    expect(res).toEqual({
      statusCode: 200,
      data: { path: '/static/export/export-file-2026-09-12.zip' },
    });
  });

  it('deletes by sign', async () => {
    const { controller, staticProvider } = createController();

    await controller.delete(SIGN);

    expect(staticProvider.deleteOneBySign).toHaveBeenCalledWith(SIGN, 'file');
  });

  it('blocks writes on the demo site', async () => {
    config.demo = 'true' as any;
    const { controller, staticProvider } = createController();

    const upload: any = await controller.upload({ originalname: 'x.pdf', buffer: Buffer.from('1') });
    const exportRes: any = await controller.exportAllAttachments();
    const del: any = await controller.delete(SIGN);

    expect(upload).toEqual({ statusCode: 401, message: '演示站禁止修改此项！' });
    expect(exportRes).toEqual({ statusCode: 401, message: '演示站禁止修改此项！' });
    expect(del).toEqual({ statusCode: 401, message: '演示站禁止修改此项！' });
    expect(staticProvider.upload).not.toHaveBeenCalled();
    expect(staticProvider.deleteOneBySign).not.toHaveBeenCalled();
  });
});
