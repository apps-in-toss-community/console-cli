import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { createMiniApp, type MiniAppSubmitPayload, uploadMiniAppResource } from './mini-apps.js';

// These two helpers are the only network surface `app register` uses.
// The submit payload shape is inferred (see CLAUDE.md "App registration")
// so we pin the *request* (URL + method + body round-trip) rather than
// asserting against a canned response — a bundle-analysis change would
// have to change the builder, not this layer.

const cookies: readonly CdpCookie[] = [
  {
    name: 'session',
    value: 'xyz',
    domain: 'apps-in-toss.toss.im',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    session: true,
  },
];

describe('uploadMiniAppResource', () => {
  it('POSTs multipart/form-data to /resource/:wid/upload with validWidth/validHeight query params', async () => {
    let capturedUrl = '';
    let capturedMethod: string | undefined;
    let capturedBody: unknown;
    const fetchImpl: FetchLike = async (input, init) => {
      capturedUrl = input instanceof URL ? input.toString() : String(input);
      capturedMethod = init?.method;
      capturedBody = init?.body;
      return new Response(
        JSON.stringify({ resultType: 'SUCCESS', success: 'https://cdn.example/logo-abc.png' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const url = await uploadMiniAppResource(
      {
        workspaceId: 3095,
        validWidth: 600,
        validHeight: 600,
        file: { buffer, fileName: 'logo.png', contentType: 'image/png' },
        cookies,
      },
      { fetchImpl },
    );
    expect(capturedMethod).toBe('POST');
    expect(capturedUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/resource/3095/upload?validWidth=600&validHeight=600',
    );
    // The body must be FormData so the runtime emits a proper multipart
    // content-type header with a boundary. A bare Buffer would send the
    // raw bytes with no boundary.
    expect(capturedBody).toBeInstanceOf(FormData);
    expect(url).toBe('https://cdn.example/logo-abc.png');
  });

  it('propagates TossApiError on FAIL envelope', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'FAIL',
          success: null,
          error: { errorType: 1, errorCode: 'IMG_TOO_LARGE', reason: 'no' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      uploadMiniAppResource(
        {
          workspaceId: 3095,
          validWidth: 600,
          validHeight: 600,
          file: {
            buffer: Buffer.from([]),
            fileName: 'logo.png',
            contentType: 'image/png',
          },
          cookies,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow(/IMG_TOO_LARGE/);
  });
});

describe('createMiniApp', () => {
  const basePayload: MiniAppSubmitPayload = {
    miniApp: {
      title: 't',
      titleEn: 'T',
      appName: 's',
      iconUri: 'https://cdn.example/logo.png',
      status: 'PREPARE',
      csEmail: 'a@b.co',
      description: 's',
      detailDescription: 'd',
      images: [
        {
          imageUrl: 'https://cdn.example/thumb.png',
          imageType: 'THUMBNAIL',
          orientation: 'HORIZONTAL',
        },
      ],
    },
    impression: { keywordList: ['k'], categoryIds: [1] },
  };

  it('POSTs the payload to /workspaces/:id/mini-app/review and returns the server response body', async () => {
    let capturedUrl = '';
    let capturedBody: string | undefined;
    let capturedMethod: string | undefined;
    const fetchImpl: FetchLike = async (input, init) => {
      capturedUrl = input instanceof URL ? input.toString() : String(input);
      capturedMethod = init?.method;
      capturedBody = typeof init?.body === 'string' ? init.body : undefined;
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { miniAppId: 123, reviewState: 'PENDING' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await createMiniApp(3095, basePayload, cookies, { fetchImpl });
    expect(capturedMethod).toBe('POST');
    expect(capturedUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/review',
    );
    const parsed = capturedBody ? JSON.parse(capturedBody) : null;
    expect(parsed?.miniApp?.title).toBe('t');
    expect(parsed?.impression?.categoryIds).toEqual([1]);
    expect(result.miniAppId).toBe(123);
    expect(result.reviewState).toBe('PENDING');
  });

  it('throws TossApiError when the server returns FAIL envelope', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'FAIL',
          success: null,
          error: { errorType: 1, errorCode: 'BAD_REQUEST', reason: 'reject' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    await expect(createMiniApp(3095, basePayload, cookies, { fetchImpl })).rejects.toThrow(
      /BAD_REQUEST/,
    );
  });
});
