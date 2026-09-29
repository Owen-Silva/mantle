/* fx-bad.js — a FIXTURE (mock only): registers a section whose id is not its file name. */
MantleSettings.section({ id: 'not-fx-bad', title: 'Bad', group: 'windows', render() { return { dispose() {} }; } });
