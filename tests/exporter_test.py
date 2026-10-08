"""A synthetic client proves migration never queries personal collections."""
import importlib.util
from pathlib import Path
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('legacy_export', root / 'scripts/export_legacy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class FakeClient:
    def __init__(self):
        self.reads = []
    def get_items(self, collection, params=None):
        self.reads.append(collection)
        if collection == 'assets':
            return [{'id': 1, 'symbol': 'DEMO', 'name': 'Synthetic', 'currency': 'USD'}]
        if collection == 'valuation_history':
            return [{'id': 1, 'asset': 1, 'valuation_date': '2025-01-31', 's_tech': 5,
                     'status': 'valid', 'is_current': True, 'revision': 1,
                     'price': 100, 'notes': 'S_Tech linear interpolation'}]
        raise AssertionError('Forbidden collection: ' + collection)
client = FakeClient()
data = module.export_data(client)
assert client.reads == ['assets', 'valuation_history']
assert data['valuations'][0]['interpolated']
assert data['prices'][0]['currency'] == 'USD'
assert data['prices'][0]['price'] == 100
assert data['schemaVersion'] == 4
assert not any(k in data for k in ['holdings', 'account', 'enrichmentJobs'])
print('Migration exporter PASS: only public asset/valuation collections read.')
