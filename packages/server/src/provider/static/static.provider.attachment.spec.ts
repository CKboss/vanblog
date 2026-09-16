import { BadRequestException, HttpException } from '@nestjs/common';
import { StaticProvider } from './static.provider';
import { ATTACHMENT_FOLDER } from 'src/utils/attachment';
import { encryptFileMD5 } from 'src/utils/crypto';

/** Mongoose queries are both awaitable and chainable; mimic that. */
function chainable(items: any[]) {
  const query: any = {
    sort: () => query,
    limit: () => query,
    skip: () => query,
    exec: async () => items,
    then: (resolve: any, reject: any) => Promise.resolve(items).then(resolve, reject),
  };
  return query;
}

function createStaticModelStub(initial: any[] = []) {
  const docs = initial.map((item) => ({ ...item }));
  const matches = (doc: any, query: any) => {
    if (!query) {
      return true;
    }
    for (const key of Object.keys(query)) {
      const expected = query[key];
      if (expected && typeof expected === 'object' && '$regex' in expected) {
        if (!new RegExp(expected.$regex, expected.$options).test(String(doc[key] ?? ''))) {
          return false;
        }
      } else if (doc[key] !== expected) {
        return false;
      }
    }
    return true;
  };

  const model: any = function StaticModel(dto: any) {
    Object.assign(this, dto);
    this.save = async () => {
      docs.push(this);
      return this;
    };
  };
  model.findOne = jest.fn((query: any) => ({
    exec: async () => docs.find((doc) => matches(doc, query)) || null,
  }));
  model.find = jest.fn((query: any) => chainable(docs.filter((doc) => matches(doc, query))));
  // 桩模型**只**提供 countDocuments：mongoose 8 已经删掉 Model.count()，
  // provider 里若退回 count() 这里会直接 TypeError（而不是静默走桩）。
  model.countDocuments = jest.fn(async (query: any) =>
    docs.filter((doc) => matches(doc, query)).length,
  );
  model.deleteOne = jest.fn((query: any) => ({
    exec: async () => {
      const idx = docs.findIndex((doc) => matches(doc, query));
      if (idx >= 0) {
        docs.splice(idx, 1);
      }
      return { deletedCount: idx >= 0 ? 1 : 0 };
    },
  }));
  return { model, docs };
}

function createProvider(options?: { storageType?: 'local' | 'picgo'; docs?: any[] }) {
  const { model, docs } = createStaticModelStub(options?.docs || []);
  const saved: any[] = [];
  const localProvider = {
    saveFile: jest.fn(async (fileName: string, buffer: Buffer, type: string) => {
      saved.push({ fileName, type, bytes: buffer.byteLength });
      return {
        realPath: `/static/${ATTACHMENT_FOLDER}/${fileName}`,
        meta: { size: `${buffer.byteLength} B`, bytes: buffer.byteLength },
      };
    }),
    deleteFile: jest.fn(async () => undefined),
    exportAllAttachments: jest.fn(async () => ({
      success: true,
      path: `/static/export/export-${ATTACHMENT_FOLDER}-2026-09-12.zip`,
    })),
  };
  const settingProvider = {
    getStaticSetting: jest.fn(async () => ({ storageType: options?.storageType || 'local' })),
  };
  const provider = new StaticProvider(
    model,
    settingProvider as any,
    localProvider as any,
    {} as any,
    {} as any,
  );
  return { provider, model, docs, saved, localProvider, settingProvider };
}

const pdfFile = (name = '年度报告.pdf', content = 'PDF-BYTES') => ({
  originalname: name,
  buffer: Buffer.from(content),
});

describe('StaticProvider attachment upload', () => {
  it('stores the file under /static/file with a hash-prefixed name', async () => {
    const { provider, docs, saved } = createProvider();

    const res: any = await provider.upload(pdfFile(), 'file');

    const sign = encryptFileMD5(Buffer.from('PDF-BYTES'));
    expect(res.isNew).toBe(true);
    expect(res.name).toBe('年度报告.pdf');
    expect(res.src).toBe(`/static/${ATTACHMENT_FOLDER}/${sign}.年度报告.pdf`);
    expect(saved[0]).toMatchObject({ fileName: `${sign}.年度报告.pdf`, type: 'file' });
    expect(docs[0]).toMatchObject({
      staticType: 'file',
      storageType: 'local',
      fileType: 'pdf',
      sign,
    });
  });

  it('never routes attachments to PicGo/OSS even when the image bed uses it', async () => {
    const { provider, docs, settingProvider } = createProvider({ storageType: 'picgo' });

    await provider.upload(pdfFile(), 'file');

    expect(settingProvider.getStaticSetting).toHaveBeenCalled();
    expect(docs[0].storageType).toBe('local');
  });

  it('dedupes identical content and keeps the first URL', async () => {
    const { provider, saved } = createProvider();

    const first: any = await provider.upload(pdfFile('a.pdf', 'SAME'), 'file');
    const second: any = await provider.upload(pdfFile('b.pdf', 'SAME'), 'file');

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.src).toBe(first.src);
    expect(saved).toHaveLength(1);
  });

  it('does not collide with an image that has identical bytes', async () => {
    const sign = encryptFileMD5(Buffer.from('SAME'));
    const { provider, saved } = createProvider({
      docs: [{ sign, staticType: 'img', name: `${sign}.pic.webp`, realPath: '/static/img/pic.webp' }],
    });

    const res: any = await provider.upload(pdfFile('a.pdf', 'SAME'), 'file');

    expect(res.isNew).toBe(true);
    expect(res.src).toContain(`/static/${ATTACHMENT_FOLDER}/`);
    expect(saved).toHaveLength(1);
  });

  it('neutralizes path traversal in the uploaded filename', async () => {
    const { provider, saved } = createProvider();

    const res: any = await provider.upload(pdfFile('../../etc/passwd', 'x'), 'file');

    expect(saved[0].fileName).not.toContain('/');
    expect(saved[0].fileName).not.toContain('..');
    expect(res.src.startsWith(`/static/${ATTACHMENT_FOLDER}/`)).toBe(true);
    expect(res.src.endsWith('.passwd')).toBe(true);
  });

  it('repairs the latin1 filename busboy produces for CJK names', async () => {
    const { provider, saved } = createProvider();
    const mangled = Buffer.from('年度报告.pdf', 'utf8').toString('latin1');

    const res: any = await provider.upload(
      { originalname: mangled, buffer: Buffer.from('CJK') },
      'file',
    );

    expect(mangled).not.toBe('年度报告.pdf');
    expect(res.name).toBe('年度报告.pdf');
    expect(saved[0].fileName.endsWith('.年度报告.pdf')).toBe(true);
    expect(res.src.endsWith('.年度报告.pdf')).toBe(true);
  });

  it('rejects an empty upload', async () => {
    const { provider } = createProvider();

    await expect(provider.upload({ originalname: 'empty.bin', buffer: Buffer.alloc(0) }, 'file')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('StaticProvider attachment listing / search / export', () => {
  const seeded = [
    { sign: 's1', staticType: 'file', name: 'aaa.report.pdf', realPath: '/static/file/aaa.report.pdf' },
    { sign: 's2', staticType: 'file', name: 'bbb.notes.txt', realPath: '/static/file/bbb.notes.txt' },
    { sign: 's3', staticType: 'img', name: 'ccc.pic.webp', realPath: '/static/file/ccc.pic.webp' },
  ];

  it('lists only attachments and filters by name', async () => {
    const { provider, model } = createProvider({ docs: seeded });

    const all: any = await provider.getByOption({
      staticType: 'file',
      page: 1,
      pageSize: 10,
      view: 'public',
    });
    expect(all.total).toBe(2);

    const filtered: any = await provider.getByOption({
      staticType: 'file',
      page: 1,
      pageSize: 10,
      view: 'public',
      name: 'report.pdf',
    });
    expect(filtered.total).toBe(1);
    expect(filtered.data[0].name).toBe('aaa.report.pdf');

    // 用户输入里的正则元字符必须被转义，不能变成非法 pattern
    const lastCall = model.find.mock.calls[model.find.mock.calls.length - 1][0];
    expect(lastCall.name.$regex).toBe('report\\.pdf');
  });

  it('treats a regex metacharacter search as a literal', async () => {
    const { provider } = createProvider({ docs: seeded });

    const res: any = await provider.getByOption({
      staticType: 'file',
      page: 1,
      pageSize: 10,
      view: 'public',
      name: 'a.*b',
    });
    expect(res.total).toBe(0);
  });

  it('exports every attachment as one zip', async () => {
    const { provider, localProvider } = createProvider({ docs: seeded });

    const path = await provider.exportAllAttachments();

    expect(localProvider.exportAllAttachments).toHaveBeenCalled();
    expect(path).toBe(`/static/export/export-${ATTACHMENT_FOLDER}-2026-09-12.zip`);
  });

  it('surfaces a packing failure as a 500', async () => {
    const { provider, localProvider } = createProvider({ docs: seeded });
    (localProvider.exportAllAttachments as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: new Error('boom'),
    });

    await expect(provider.exportAllAttachments()).rejects.toBeInstanceOf(HttpException);
  });
});
