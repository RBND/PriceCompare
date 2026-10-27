'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { StorageEngine } = require('../src/storage');
const { app } = require('../server');

test('StorageEngine: multi-project lifecycle, isolation, and security', (t) => {
  const tmpDataDir = path.join(__dirname, 'tmp-data-' + Date.now());
  const storage = new StorageEngine(tmpDataDir);

  // 1. Initial state has default project
  const initialProjects = storage.listProjects();
  assert.equal(initialProjects.length, 1);
  assert.equal(initialProjects[0].id, 'corvette-z51');

  // 2. Create a new blank project
  const created = storage.createProject('Engine Overhaul 2026', 'blank');
  assert.equal(created.id, 'engine-overhaul-2026');
  assert.equal(created.state.parts.length, 0);
  assert.equal(created.state.listings.length, 0);
  assert.equal(created.state.settings.projectName, 'Engine Overhaul 2026');

  // Verify list has 2 projects now
  const listAfterCreate = storage.listProjects();
  assert.equal(listAfterCreate.length, 2);

  // 3. Save modifications to the new project without affecting corvette-z51
  created.state.parts.push({
    id: 'part-eng-1',
    name: 'Piston Ring Set',
    partNumbers: ['PR-992'],
    shopPrice: 120.0,
    shopTaxable: true,
    notes: 'Standard bore'
  });
  storage.saveProject(created.id, created.state);

  const reloaded = storage.getProject(created.id);
  assert.equal(reloaded.parts.length, 1);
  assert.equal(reloaded.parts[0].name, 'Piston Ring Set');

  const corvetteState = storage.getProject('corvette-z51');
  assert.equal(corvetteState.parts.length, 11, 'Corvette parts should remain unaffected');

  // 4. Duplicate project
  const duplicated = storage.duplicateProject(created.id, 'Engine Overhaul Backup');
  assert.equal(duplicated.state.settings.projectName, 'Engine Overhaul Backup');
  assert.equal(duplicated.state.parts.length, 1);
  assert.equal(duplicated.state.parts[0].name, 'Piston Ring Set');

  // 5. Rename project
  const renamed = storage.renameProject(duplicated.id, 'Engine Overhaul Staging');
  assert.equal(renamed.settings.projectName, 'Engine Overhaul Staging');

  // 6. Delete project
  const deleteRes = storage.deleteProject(duplicated.id);
  assert.equal(deleteRes.ok, true);
  assert.equal(storage.getProject(duplicated.id), null);

  // 7. Security: reject path traversal IDs
  assert.throws(() => {
    storage.getProject('../etc/passwd');
  }, /Invalid project identifier/);

  assert.throws(() => {
    storage.saveProject('bad/id', {});
  }, /Invalid project identifier/);

  // 8. Safety: cannot delete only remaining project
  storage.deleteProject(created.id);
  assert.equal(storage.listProjects().length, 1);
  assert.throws(() => {
    storage.deleteProject('corvette-z51');
  }, /Cannot delete the only remaining project/);

  // Cleanup tmp dir
  try {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {}
});

test('RESTful API: /api/projects endpoints', async (t) => {
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /api/projects
    const listRes = await fetch(`${baseUrl}/api/projects`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(Array.isArray(listData.projects));
    assert.ok(listData.projects.length >= 1);

    // 2. POST /api/projects (Create new project)
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mustang Track Build', template: 'blank' })
    });
    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    assert.equal(createData.ok, true);
    assert.ok(createData.id.startsWith('mustang-track-build'));
    assert.equal(createData.state.parts.length, 0);

    const testProjId = createData.id;

    // 3. GET /api/projects/:id
    const getRes = await fetch(`${baseUrl}/api/projects/${testProjId}`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.state.settings.projectName, 'Mustang Track Build');

    // 4. PUT /api/projects/:id (Update state)
    getData.state.parts.push({
      id: 'part-m1',
      name: 'Brembo Brake Caliper',
      partNumbers: ['BR-100'],
      shopPrice: 450.0,
      shopTaxable: true,
      notes: 'Front right'
    });
    const putRes = await fetch(`${baseUrl}/api/projects/${testProjId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: getData.state })
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.state.parts.length, 1);

    // 5. POST /api/projects/:id/duplicate
    const dupRes = await fetch(`${baseUrl}/api/projects/${testProjId}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mustang Street Build' })
    });
    assert.equal(dupRes.status, 201);
    const dupData = await dupRes.json();
    assert.equal(dupData.state.settings.projectName, 'Mustang Street Build');
    assert.equal(dupData.state.parts.length, 1);

    // 6. PATCH /api/projects/:id/rename
    const patchRes = await fetch(`${baseUrl}/api/projects/${dupData.id}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mustang Daily Driver' })
    });
    assert.equal(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.equal(patchData.state.settings.projectName, 'Mustang Daily Driver');

    // 7. GET /api/projects/:id/export/json
    const exportJsonRes = await fetch(`${baseUrl}/api/projects/${testProjId}/export/json`);
    assert.equal(exportJsonRes.status, 200);
    assert.equal(exportJsonRes.headers.get('content-type'), 'application/json; charset=utf-8');

    // 8. GET /api/projects/:id/export/xlsx
    const exportXlsxRes = await fetch(`${baseUrl}/api/projects/${testProjId}/export/xlsx`);
    assert.equal(exportXlsxRes.status, 200);
    assert.ok(exportXlsxRes.headers.get('content-type').includes('openxmlformats'));

    // 9. DELETE /api/projects/:id
    const del1 = await fetch(`${baseUrl}/api/projects/${dupData.id}`, { method: 'DELETE' });
    assert.equal(del1.status, 200);
    const del2 = await fetch(`${baseUrl}/api/projects/${testProjId}`, { method: 'DELETE' });
    assert.equal(del2.status, 200);

    // 10. Security: Traversal in path param rejected
    const badRes = await fetch(`${baseUrl}/api/projects/..%2F..%2Fetc`);
    assert.equal(badRes.status, 400);

  } finally {
    server.close();
  }
});
