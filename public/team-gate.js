/* Role gate for the pages outside the dashboard (pppoe.html, operations.html).
 *
 * The server refuses anything a role can't do (src/lib/team.js). This only
 * keeps a staff member from landing on controls that would just say no.
 *
 *   FitiGate.can(member, permission)
 *     member is the `member` from /api/business/me. permission is a name or a
 *     list (any one is enough). No member (an older server) or the owner:
 *     always true.
 *   FitiGate.blocked(target, member, options)
 *     Replaces what is in `target` with "Your role can't open this page" and
 *     a link back to the dashboard. options: cardClass, linkClass, what. */
(function (root) {
  'use strict';
  function can(member, permission) {
    if (!member || member.role === 'owner') return true;
    var wanted = Array.isArray(permission) ? permission : [permission];
    var granted = member.permissions || [];
    return wanted.some(function (item) { return granted.indexOf(item) !== -1; });
  }
  function blocked(target, member, options) {
    options = options || {};
    var doc = target.ownerDocument || root.document;
    var role = (member && (member.roleLabel || member.role)) || 'a team member';
    var card = doc.createElement('section');
    card.className = options.cardClass || 'card';
    card.id = 'role-blocked';
    card.setAttribute('role', 'status');
    var title = doc.createElement('h2');
    title.textContent = 'Your role can’t open this page';
    var text = doc.createElement('p');
    text.textContent = 'You are signed in as ' + role + '. ' + (options.what ? options.what + ' ' : '') + 'Ask the owner if you need it.';
    var back = doc.createElement('a');
    back.href = '/business.html';
    if (options.linkClass) back.className = options.linkClass;
    back.textContent = 'Back to the dashboard';
    card.appendChild(title); card.appendChild(text); card.appendChild(back);
    while (target.firstChild) target.removeChild(target.firstChild);
    target.appendChild(card);
    return card;
  }
  root.FitiGate = { can: can, blocked: blocked };
})(typeof window !== 'undefined' ? window : this);
