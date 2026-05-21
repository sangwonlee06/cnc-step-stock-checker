const occtImportBaseUrl = '/static/vendor/occt-import-js/';
let occtPromise = null;

importScripts (occtImportBaseUrl + 'occt-import-js.js');

function getOcct ()
{
	if (occtPromise === null) {
		let modulOverrides = {
			locateFile: function (path) {
				return occtImportBaseUrl + path;
			}
		};
		occtPromise = occtimportjs (modulOverrides);
	}
	return occtPromise;
}

onmessage = async function (ev)
{
	let occt = await getOcct ();
	if (ev.data && ev.data.type === 'warmup') {
		postMessage ({ type: 'warmup', success: true });
		return;
	}
	let result = occt.ReadFile (ev.data.format, ev.data.buffer, ev.data.params);
	postMessage (result);
};
