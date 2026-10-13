/* page-stopped.js - fills in page-stopped.html from its query (?what=&why=&compact=1). Plain text only. */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var what = q.get('what');
  var why = q.get('why');
  if (what) document.getElementById('what').textContent = what;
  if (why) document.getElementById('why').textContent = why;
  if (q.get('compact') === '1') document.body.classList.add('compact');
  document.title = 'Mantle: ' + (what || 'a page') + ' stopped';
}());
