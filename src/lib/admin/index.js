'use strict';

/**
 * Platform administration boundary.
 *
 * All privileged dashboard APIs are mounted from this single module. The
 * customer portal, tenant business operations, router polling, and payment
 * provisioning are intentionally mounted elsewhere and do not depend on it.
 */
function attachAdminModule(app, dependencies) {
  const { db, adminOk } = dependencies;
  require('../fiti-signal-admin').attachFitiSignalAdmin(app, { db, adminOk });
  require('../platform-admin').attachPlatformAdmin(app, { db, adminOk });
  require('../fiti-signal-admin-controls').attachFitiSignalAdminControls(app, { db, adminOk });
  app.get('/admin', (req, res) => res.redirect(302, '/platform-admin.html'));
}

module.exports = { attachAdminModule };
