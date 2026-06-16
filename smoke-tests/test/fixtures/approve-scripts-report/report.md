# npm Lifecycle Script Approval Review

> **Note:** This report is best-effort and does not claim to prove a package is safe.
> A human must review this evidence before approving or denying any package.

## Package: nx@20.8.4

**Location:** `node_modules/@lerna/create/node_modules/nx`  
**Dependency type:** transitive  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- lerna-monorepo → lerna@8.2.4 → @lerna/create@8.2.4 → nx@20.8.4
- lerna-monorepo → lerna@8.2.4 → @lerna/create@8.2.4 → @nx/devkit@20.8.4 → nx@20.8.4

**Lifecycle scripts:**
```json
{
  "postinstall": "node ./bin/post-install"
}
```

### Referenced files

#### `bin\\post-install`

**Reason:** referenced by lifecycle script: `postinstall`  

**Detected signals:**
- file could not be read

### Actions

- **Approve (pinned):** `npm approve-scripts nx`
- **Approve (any version):** `npm approve-scripts --no-allow-scripts-pin nx`
- **Deny:** `npm deny-scripts nx`

---

## Package: @swc/core@1.13.3

**Location:** `node_modules/@swc/core`  
**Dependency type:** direct  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- lerna-monorepo → @swc/core@1.13.3
- lerna-monorepo → lerna@8.2.4 → @lerna/create@8.2.4 → nx@20.8.4 → @swc/core@1.13.3
- lerna-monorepo → lerna@8.2.4 → @lerna/create@8.2.4 → @nx/devkit@20.8.4 → nx@20.8.4 → @swc/core@1.13.3
- lerna-monorepo → @swc-node/register@1.10.10 → @swc-node/core@1.14.1 → @swc/core@1.13.3
- lerna-monorepo → lerna@8.2.4 → @lerna/create@8.2.4 → nx@20.8.4 → @swc-node/register@1.10.10 → @swc-node/core@1.14.1 → @swc/core@1.13.3
- lerna-monorepo → lerna@8.2.4 → @lerna/create@8.2.4 → @nx/devkit@20.8.4 → nx@20.8.4 → @swc-node/register@1.10.10 → @swc-node/core@1.14.1 → @swc/core@1.13.3
- lerna-monorepo → lerna@8.2.4 → nx@20.8.4 → @swc-node/register@1.10.10 → @swc-node/core@1.14.1 → @swc/core@1.13.3
- lerna-monorepo → lerna@8.2.4 → @nx/devkit@20.8.4 → nx@20.8.4 → @swc-node/register@1.10.10 → @swc-node/core@1.14.1 → @swc/core@1.13.3

**Lifecycle scripts:**
```json
{
  "postinstall": "node postinstall.js"
}
```

### Referenced files

#### `postinstall.js`

**Reason:** referenced by lifecycle script: `postinstall`  
**SHA-256:** `5da0f556c5702eaf4c4b66283f03aeccbd8db3d4b730866741ca23c799614a87`  
**Size:** 6.9 kB  

**Detected signals:**
- uses child_process (can spawn external commands)
- reads process.env
- writes files to disk
- references external URLs
- imports local files

**Local imports:**
- `binding.js`

#### `binding.js`

**Reason:** required by ./postinstall.js  
**SHA-256:** `f27d35d079238ee97dd44a45126a3dee3643827ef0c2ee6331f31c2f7e79507c`  
**Size:** 9.2 kB  

**Detected signals:**
- uses child_process (can spawn external commands)
- reads process.env
- imports local files

### Risk summary

- uses child_process (can spawn external commands)

### Suggested review focus

- confirm what external commands are executed and whether they are constrained

### Actions

- **Approve (pinned):** `npm approve-scripts @swc/core`
- **Approve (any version):** `npm approve-scripts --no-allow-scripts-pin @swc/core`
- **Deny:** `npm deny-scripts @swc/core`

---

## Package: esbuild@0.25.8

**Location:** `node_modules/esbuild`  
**Dependency type:** direct  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- lerna-monorepo → esbuild@0.25.8
- lerna-monorepo → @nx/esbuild@22.0.3 → esbuild@0.25.8

**Lifecycle scripts:**
```json
{
  "postinstall": "node install.js"
}
```

### Referenced files

#### `install.js`

**Reason:** referenced by lifecycle script: `postinstall`  
**SHA-256:** `10f6fa3644d8d23d066ff67b0ae449074e75884503546a9fedb667f1dcb9ade2`  
**Size:** 11.2 kB  

**Detected signals:**
- uses child_process (can spawn external commands)
- reads process.env
- makes network requests
- references external URLs

### Risk summary

- uses child_process (can spawn external commands)
- makes network requests

### Suggested review focus

- confirm what external commands are executed and whether they are constrained
- confirm what remote endpoints are contacted and whether responses are verified

### Actions

- **Approve (pinned):** `npm approve-scripts esbuild`
- **Approve (any version):** `npm approve-scripts --no-allow-scripts-pin esbuild`
- **Deny:** `npm deny-scripts esbuild`

---

## Package: nx@20.8.4

**Location:** `node_modules/lerna/node_modules/nx`  
**Dependency type:** transitive  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- lerna-monorepo → lerna@8.2.4 → nx@20.8.4
- lerna-monorepo → lerna@8.2.4 → @nx/devkit@20.8.4 → nx@20.8.4

**Lifecycle scripts:**
```json
{
  "postinstall": "node ./bin/post-install"
}
```

### Referenced files

#### `bin\\post-install`

**Reason:** referenced by lifecycle script: `postinstall`  

**Detected signals:**
- file could not be read

### Actions

- **Approve (pinned):** `npm approve-scripts nx`
- **Approve (any version):** `npm approve-scripts --no-allow-scripts-pin nx`
- **Deny:** `npm deny-scripts nx`

---

## Package: nx@22.0.3

**Location:** `node_modules/nx`  
**Dependency type:** direct  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- lerna-monorepo → nx@22.0.3
- lerna-monorepo → @nx/esbuild@22.0.3 → @nx/devkit@22.0.3 → nx@22.0.3
- lerna-monorepo → @nx/eslint@22.0.3 → @nx/devkit@22.0.3 → nx@22.0.3
- lerna-monorepo → @nx/plugin@22.0.3 → @nx/eslint@22.0.3 → @nx/devkit@22.0.3 → nx@22.0.3
- lerna-monorepo → @nx/eslint-plugin@22.0.3 → @nx/devkit@22.0.3 → nx@22.0.3
- lerna-monorepo → @nx/jest@22.0.3 → @nx/devkit@22.0.3 → nx@22.0.3
- lerna-monorepo → @nx/plugin@22.0.3 → @nx/jest@22.0.3 → @nx/devkit@22.0.3 → nx@22.0.3
- lerna-monorepo → @nx/js@22.0.3 → @nx/devkit@22.0.3 → nx@22.0.3

**Lifecycle scripts:**
```json
{
  "postinstall": "node ./bin/post-install || exit 0"
}
```

### Referenced files

#### `bin\\post-install`

**Reason:** referenced by lifecycle script: `postinstall`  

**Detected signals:**
- file could not be read

### Actions

- **Approve (pinned):** `npm approve-scripts nx`
- **Approve (any version):** `npm approve-scripts --no-allow-scripts-pin nx`
- **Deny:** `npm deny-scripts nx`

---

## Package: unrs-resolver@1.12.2

**Location:** `node_modules/unrs-resolver`  
**Dependency type:** transitive  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- lerna-monorepo → jest@30.0.5 → @jest/core@30.0.5 → jest-resolve@30.0.5 → unrs-resolver@1.12.2
- lerna-monorepo → ts-jest@29.4.1 → jest@30.0.5 → @jest/core@30.0.5 → jest-resolve@30.0.5 → unrs-resolver@1.12.2
- lerna-monorepo → jest@30.0.5 → jest-cli@30.0.5 → @jest/core@30.0.5 → jest-resolve@30.0.5 → unrs-resolver@1.12.2
- lerna-monorepo → ts-jest@29.4.1 → jest@30.0.5 → jest-cli@30.0.5 → @jest/core@30.0.5 → jest-resolve@30.0.5 → unrs-resolver@1.12.2
- lerna-monorepo → jest@30.0.5 → @jest/core@30.0.5 → jest-config@30.0.5 → jest-resolve@30.0.5 → unrs-resolver@1.12.2
- lerna-monorepo → ts-jest@29.4.1 → jest@30.0.5 → @jest/core@30.0.5 → jest-config@30.0.5 → jest-resolve@30.0.5 → unrs-resolver@1.12.2
- lerna-monorepo → jest@30.0.5 → jest-cli@30.0.5 → @jest/core@30.0.5 → jest-config@30.0.5 → jest-resolve@30.0.5 → unrs-resolver@1.12.2
- lerna-monorepo → ts-jest@29.4.1 → jest@30.0.5 → jest-cli@30.0.5 → @jest/core@30.0.5 → jest-config@30.0.5 → jest-resolve@30.0.5 → unrs-resolver@1.12.2

**Lifecycle scripts:**
```json
{
  "postinstall": "node postinstall.js"
}
```

### Referenced files

#### `postinstall.js`

**Reason:** referenced by lifecycle script: `postinstall`  
**SHA-256:** `446a0aeed55eeb28eadd9ac31f0b71654265aba8ca5a99dbc22dab0b26a02469`  
**Size:** 156 B  

**Detected signals:**
- imports local files

**Local imports:**
- `package.json`

#### `package.json`

**Reason:** required by ./postinstall.js  
**SHA-256:** `3ef3f74675fe31a88dc490e4136178a5fd8f96142df0c565d66be9a894543adf`  
**Size:** 2.9 kB  

**Detected signals:**
- references external URLs

### Actions

- **Approve (pinned):** `npm approve-scripts unrs-resolver`
- **Approve (any version):** `npm approve-scripts --no-allow-scripts-pin unrs-resolver`
- **Deny:** `npm deny-scripts unrs-resolver`

---
