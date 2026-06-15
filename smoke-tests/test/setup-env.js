const t = require('tap')
const setup = require('./fixtures/setup.js')

t.test('spawn forwards NODE_EXTRA_CA_CERTS only when defined', async (t) => {
  const { spawn } = await setup(t)
  const { stdout } = await spawn(process.execPath, [
    '-p',
    "Object.prototype.hasOwnProperty.call(process.env, 'NODE_EXTRA_CA_CERTS') ? process.env.NODE_EXTRA_CA_CERTS : '<missing>'",
  ])

  t.equal(stdout.trim(), process.env.NODE_EXTRA_CA_CERTS || '<missing>')
})
