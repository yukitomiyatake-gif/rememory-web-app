import fs from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
if (!['ensure-users', 'seed', 'validate', 'delete', 'post-delete'].includes(mode)) throw new Error('Usage: node tests/staging-validation.mjs ensure-users|seed|validate|delete|post-delete');

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const config = JSON.parse(await fs.readFile(path.join(root, '.env.staging.local'), 'utf8'));
const evidence = { mode, startedAt: new Date().toISOString(), project: 'rememory-staging', tests: [] };
const stageOrigin = 'http://localhost:4173';

async function request(url, { method = 'GET', token = config.anonKey, body, headers = {} } = {}) {
  const apiKey = token === config.serviceKey ? config.serviceKey : config.anonKey;
  const response = await fetch(url, {
    method,
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)
  });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, data, contentRange: response.headers.get('content-range') };
}

async function login(user) {
  const result = await request(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    body: { email: user.email, password: user.password }
  });
  if (result.status !== 200) throw new Error(`Login failed: ${result.status}`);
  return { token: result.data.access_token, id: result.data.user.id };
}

function addTest(operation, expected, result, pass, counts = {}) {
  evidence.tests.push({
    at: new Date().toISOString(), operation, expected,
    actual: { status: result?.status ?? null, counts, error: pass ? null : result?.data ?? null },
    pass
  });
}

async function rest(table, token, method = 'GET', query = '', body, extraHeaders = {}) {
  return request(`${config.url}/rest/v1/${table}${query}`, {
    method, token, body,
    headers: { Prefer: 'return=representation,count=exact', ...extraHeaders }
  });
}

function ids(userId, label) {
  return { memory: `stage-${label}-memory`, fragment: `stage-${label}-fragment`, reflection: `stage-${label}-reflection`, userId };
}

let a;
let b;
let A;
let B;

if (mode === 'ensure-users') {
  for (const [label, user] of [['A', config.userA], ['B', config.userB]]) {
    const existing = await login(user).catch(() => null);
    if (existing) {
      addTest(`Ensure user ${label}`, 'already exists', { status: 200 }, true);
      continue;
    }
    const created = await request(`${config.url}/auth/v1/admin/users`, {
      method: 'POST', token: config.serviceKey,
      body: { email: user.email, password: user.password, email_confirm: true }
    });
    addTest(`Ensure user ${label}`, '200', created, created.status === 200);
  }
} else {
  b = await login(config.userB);
  a = mode === 'post-delete' ? null : await login(config.userA);
  A = ids(a?.id || '', 'a');
  B = ids(b.id, 'b');
}

async function seedUser(session, fixture, label) {
  const profileResult = await rest('profiles', config.serviceKey, 'POST', '', { id: fixture.userId, display_name: `Stage ${label}`, avatar_url: '' }, { Prefer: 'resolution=merge-duplicates,return=representation' });
  addTest(`${label} seed profile`, '200 or 201', profileResult, [200, 201].includes(profileResult.status));
  const memory = { id: fixture.memory, user_id: fixture.userId, title: `Synthetic ${label}`, status: 'sleeping', original_image_path: `${fixture.userId}/${fixture.memory}/original.jpg`, payload: { synthetic: true } };
  const memoryResult = await rest('memories', session.token, 'POST', '', memory, { Prefer: 'resolution=merge-duplicates,return=representation' });
  addTest(`${label} seed memory`, '201', memoryResult, [200, 201].includes(memoryResult.status));
  for (let index = 0; index < 9; index++) {
    const fragment = { id: `${fixture.fragment}-${index}`, memory_id: fixture.memory, user_id: fixture.userId, fragment_index: index, image_path: `${fixture.userId}/${fixture.memory}/fragment-${index}.jpg`, payload: { synthetic: true } };
    const result = await rest('memory_fragments', session.token, 'POST', '', fragment, { Prefer: 'resolution=merge-duplicates,return=representation' });
    addTest(`${label} seed fragment ${index}`, '201', result, [200, 201].includes(result.status));
  }
  const reflection = { id: fixture.reflection, memory_id: fixture.memory, user_id: fixture.userId, reflection_type: 'fragment', body: 'synthetic', payload: { synthetic: true } };
  const reflectionResult = await rest('memory_reflections', session.token, 'POST', '', reflection, { Prefer: 'resolution=merge-duplicates,return=representation' });
  addTest(`${label} seed reflection`, '201', reflectionResult, [200, 201].includes(reflectionResult.status));
  const settingsResult = await rest('user_settings', session.token, 'POST', '', { user_id: fixture.userId, settings: { synthetic: true } }, { Prefer: 'resolution=merge-duplicates,return=representation' });
  addTest(`${label} seed settings`, '201', settingsResult, [200, 201].includes(settingsResult.status));
}

async function uploadSynthetic(session, fixture) {
  const bytes = Uint8Array.from([255,216,255,217]);
  const objectPath = `${fixture.userId}/${fixture.memory}/original.jpg`;
  return request(`${config.url}/storage/v1/object/memory-images/${objectPath}`, {
    method: 'POST', token: session.token, body: bytes,
    headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }
  });
}

if (mode === 'seed') {
  await seedUser(a, A, 'A');
  await seedUser(b, B, 'B');
}

if (mode === 'validate') {
  for (const [label, session, own, other] of [['A', a, A, B], ['B', b, B, A]]) {
    const ownSelect = await rest('memories', session.token, 'GET', `?id=eq.${own.memory}&select=id`);
    addTest(`${label} SELECT own`, '200 and 1 row', ownSelect, ownSelect.status === 200 && ownSelect.data.length === 1, { rows: ownSelect.data?.length });
    const otherSelect = await rest('memories', session.token, 'GET', `?id=eq.${other.memory}&select=id`);
    addTest(`${label} SELECT other`, '200 and 0 rows', otherSelect, otherSelect.status === 200 && otherSelect.data.length === 0, { rows: otherSelect.data?.length });
    const otherUpdate = await rest('memories', session.token, 'PATCH', `?id=eq.${other.memory}`, { title: 'blocked' });
    addTest(`${label} UPDATE other`, '200 and 0 rows', otherUpdate, otherUpdate.status === 200 && otherUpdate.data.length === 0, { rows: otherUpdate.data?.length });
    const otherDelete = await rest('memories', session.token, 'DELETE', `?id=eq.${other.memory}`);
    addTest(`${label} DELETE other`, '200 and 0 rows', otherDelete, otherDelete.status === 200 && otherDelete.data.length === 0, { rows: otherDelete.data?.length });
    const tempId = `stage-${label.toLowerCase()}-crud`;
    const insertOwn = await rest('memories', session.token, 'POST', '', { id: tempId, user_id: own.userId, title: 'crud', status: 'sleeping', original_image_path: `${own.userId}/${tempId}/original.jpg`, payload: {} });
    addTest(`${label} INSERT own`, '201', insertOwn, insertOwn.status === 201);
    const updateOwn = await rest('memories', session.token, 'PATCH', `?id=eq.${tempId}`, { title: 'updated' });
    addTest(`${label} UPDATE own`, '200 and 1 row', updateOwn, updateOwn.status === 200 && updateOwn.data.length === 1, { rows: updateOwn.data?.length });
    const deleteOwn = await rest('memories', session.token, 'DELETE', `?id=eq.${tempId}`);
    addTest(`${label} DELETE own`, '200 and 1 row', deleteOwn, deleteOwn.status === 200 && deleteOwn.data.length === 1, { rows: deleteOwn.data?.length });
    const crossFragment = await rest('memory_fragments', session.token, 'POST', '', { id: `blocked-fragment-${label}`, memory_id: other.memory, user_id: own.userId, fragment_index: 0, image_path: `${own.userId}/blocked/fragment-0.jpg`, payload: {} });
    addTest(`${label} cross-parent fragment`, '403', crossFragment, crossFragment.status === 403);
    const crossReflection = await rest('memory_reflections', session.token, 'POST', '', { id: `blocked-reflection-${label}`, memory_id: other.memory, user_id: own.userId, reflection_type: 'fragment', body: '', payload: {} });
    addTest(`${label} cross-parent reflection`, '403', crossReflection, crossReflection.status === 403);
  }
  const anonymousSelect = await rest('memories', config.anonKey, 'GET', '?select=id');
  const anonymousSelectBlocked = [401, 403].includes(anonymousSelect.status)
    || (anonymousSelect.status === 200 && Array.isArray(anonymousSelect.data) && anonymousSelect.data.length === 0);
  addTest('Anonymous SELECT', '401/403 or 200 and 0 rows', anonymousSelect, anonymousSelectBlocked, { rows: anonymousSelect.data?.length });
  const anonymousInsert = await rest('memories', config.anonKey, 'POST', '', { id: 'anon-blocked', user_id: A.userId, title: '', status: 'sleeping', original_image_path: 'blocked', payload: {} });
  addTest('Anonymous INSERT', '401 or 403', anonymousInsert, [401, 403].includes(anonymousInsert.status));
  const uploadA = await uploadSynthetic(a, A); addTest('A upload own image', '200', uploadA, [200,201].includes(uploadA.status));
  const uploadB = await uploadSynthetic(b, B); addTest('B upload own image', '200', uploadB, [200,201].includes(uploadB.status));
  const ownImage = await request(`${config.url}/storage/v1/object/authenticated/memory-images/${A.userId}/${A.memory}/original.jpg`, { token: a.token });
  addTest('A download own image', '200', ownImage, ownImage.status === 200);
  const otherImage = await request(`${config.url}/storage/v1/object/authenticated/memory-images/${B.userId}/${B.memory}/original.jpg`, { token: a.token });
  addTest('A download B image', 'not 200', otherImage, otherImage.status !== 200);
}

if (mode === 'delete') {
  const fn = `${config.url}/functions/v1/delete-account`;
  const noOrigin = await request(fn, { method: 'POST', token: a.token, body: { confirmation: 'DELETE_MY_ACCOUNT' } });
  addTest('Delete without Origin', '403', noOrigin, noOrigin.status === 403);
  const badOrigin = await request(fn, { method: 'POST', token: a.token, body: { confirmation: 'DELETE_MY_ACCOUNT' }, headers: { Origin: 'https://invalid.example' } });
  addTest('Delete mismatched Origin', '403', badOrigin, badOrigin.status === 403);
  const extraId = await request(fn, { method: 'POST', token: a.token, body: { confirmation: 'DELETE_MY_ACCOUNT', user_id: b.id }, headers: { Origin: stageOrigin } });
  addTest('Delete body user_id rejected', '400', extraId, extraId.status === 400);
  const deletion = await request(fn, { method: 'POST', token: a.token, body: { confirmation: 'DELETE_MY_ACCOUNT' }, headers: { Origin: stageOrigin } });
  addTest('Delete user A', '200', deletion, deletion.status === 200);
  for (const table of ['memory_reflections','memory_fragments','memories','user_settings']) {
    const aRows = await rest(table, config.serviceKey, 'GET', `?user_id=eq.${A.userId}&select=*`);
    const bRows = await rest(table, config.serviceKey, 'GET', `?user_id=eq.${B.userId}&select=*`);
    addTest(`${table} A removed`, '0 rows', aRows, aRows.status === 200 && aRows.data.length === 0, { rows: aRows.data?.length });
    addTest(`${table} B retained`, 'more than 0 rows', bRows, bRows.status === 200 && bRows.data.length > 0, { rows: bRows.data?.length });
  }
  const profileA = await rest('profiles', config.serviceKey, 'GET', `?id=eq.${A.userId}&select=id`);
  const profileB = await rest('profiles', config.serviceKey, 'GET', `?id=eq.${B.userId}&select=id`);
  addTest('Profile A removed', '0 rows', profileA, profileA.status === 200 && profileA.data.length === 0, { rows: profileA.data?.length });
  addTest('Profile B retained', '1 row', profileB, profileB.status === 200 && profileB.data.length === 1, { rows: profileB.data?.length });
  const authA = await request(`${config.url}/auth/v1/admin/users/${A.userId}`, { token: config.serviceKey });
  const authB = await request(`${config.url}/auth/v1/admin/users/${B.userId}`, { token: config.serviceKey });
  addTest('Auth A removed', '404', authA, authA.status === 404);
  addTest('Auth B retained', '200', authB, authB.status === 200);
  const listA = await request(`${config.url}/storage/v1/object/list/memory-images`, { method: 'POST', token: config.serviceKey, body: { prefix: A.userId, limit: 100 } });
  const listB = await request(`${config.url}/storage/v1/object/list/memory-images`, { method: 'POST', token: config.serviceKey, body: { prefix: B.userId, limit: 100 } });
  addTest('Storage A removed', '0 objects', listA, listA.status === 200 && listA.data.length === 0, { objects: listA.data?.length });
  addTest('Storage B retained', 'more than 0 objects', listB, listB.status === 200 && listB.data.length > 0, { objects: listB.data?.length });
}

if (mode === 'post-delete') {
  const aMemory = await rest('memories', config.serviceKey, 'GET', '?id=eq.stage-a-memory&select=id');
  const bMemory = await rest('memories', config.serviceKey, 'GET', '?id=eq.stage-b-memory&select=id');
  addTest('Post-delete A memory removed', '0 rows', aMemory, aMemory.status === 200 && aMemory.data.length === 0, { rows: aMemory.data?.length });
  addTest('Post-delete B memory retained', '1 row', bMemory, bMemory.status === 200 && bMemory.data.length === 1, { rows: bMemory.data?.length });
  for (const table of ['memory_fragments', 'memory_reflections']) {
    const aRows = await rest(table, config.serviceKey, 'GET', '?memory_id=eq.stage-a-memory&select=id');
    const bRows = await rest(table, config.serviceKey, 'GET', '?memory_id=eq.stage-b-memory&select=id');
    addTest(`Post-delete ${table} A removed`, '0 rows', aRows, aRows.status === 200 && aRows.data.length === 0, { rows: aRows.data?.length });
    addTest(`Post-delete ${table} B retained`, 'more than 0 rows', bRows, bRows.status === 200 && bRows.data.length > 0, { rows: bRows.data?.length });
  }
  for (const table of ['profiles', 'user_settings']) {
    const rows = await rest(table, config.serviceKey, 'GET', '?select=*');
    const ownerKey = table === 'profiles' ? 'id' : 'user_id';
    const onlyB = rows.status === 200 && rows.data.length === 1 && rows.data[0][ownerKey] === B.userId;
    addTest(`Post-delete ${table} only B retained`, '1 B row', rows, onlyB, { rows: rows.data?.length });
  }
  const authUsers = await request(`${config.url}/auth/v1/admin/users`, { token: config.serviceKey });
  const users = authUsers.data?.users || [];
  const authPass = authUsers.status === 200 && !users.some((user) => user.email === config.userA.email) && users.some((user) => user.email === config.userB.email);
  addTest('Post-delete Auth only B retained', 'A absent and B present', authUsers, authPass, { users: users.length });
}

evidence.finishedAt = new Date().toISOString();
evidence.pass = evidence.tests.every((test) => test.pass);
await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
const output = path.join(root, 'artifacts', `staging-validation-${mode}-${Date.now()}.json`);
await fs.writeFile(output, JSON.stringify(evidence, null, 2));
process.stdout.write(JSON.stringify({ mode, pass: evidence.pass, tests: evidence.tests.length, failed: evidence.tests.filter((test) => !test.pass).map((test) => test.operation), evidence: path.basename(output) }));
if (!evidence.pass) process.exitCode = 1;
