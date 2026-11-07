import importlib.util
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import subprocess
import sys
import csv

from openpyxl import Workbook

spec = importlib.util.spec_from_file_location('settlement', Path(__file__).with_name('settlement-to-csv.py'))
settlement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settlement)


class SettlementTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def workbook(self, name='sample.xlsx', **changes):
        values = dict(order_ref='GMM-00000123', service_ref='GMM-00000123',
                      delivery_date=datetime(2026, 11, 6), subtotal=25.5, total=28.5,
                      merchant_net=20.4, batch_id=24, business_date=datetime(2026, 11, 6),
                      entry_type='NORMAL', service_status='COMPLETED', service_type='FOOD_DELIVERY')
        values.update(changes)
        book = Workbook()
        sheet = book.active
        sheet.title = 'Service Jobs'
        sheet.append(list(settlement.FIELDS.values()))
        sheet.append([values[key] for key in settlement.FIELDS])
        path = Path(self.temp.name) / name
        book.save(path)
        book.close()
        return path

    def test_dates_amounts_and_references(self):
        rows = settlement.read_orders([self.workbook()])
        self.assertEqual(rows[0]['order_ref'], 'GMM-00000123')
        self.assertEqual(rows[0]['delivery_date'], '2026-11-06')
        self.assertEqual(rows[0]['subtotal'], '25.50')
        self.assertEqual(rows[0]['merchant_net'], '20.40')

    def test_repeat_file_does_not_double_count(self):
        path = self.workbook()
        self.assertEqual(len(settlement.read_orders([path, path])), 1)

    def test_conflicting_duplicate_is_rejected(self):
        first = self.workbook()
        second = self.workbook('other.xlsx', subtotal=26)
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            settlement.read_orders([first, second])

    def test_adjustments_are_not_counted_as_new_sales(self):
        with self.assertRaisesRegex(ValueError, 'Adjustment'):
            settlement.read_orders([self.workbook(entry_type='ADJUSTMENT')])

    def test_missing_date_does_not_become_today(self):
        with self.assertRaisesRegex(ValueError, 'date'):
            settlement.read_orders([self.workbook(delivery_date=None)])

    def test_summary_workbook_is_rejected(self):
        path = Path(self.temp.name) / 'analytics.xlsx'
        book = Workbook()
        book.save(path)
        book.close()
        with self.assertRaisesRegex(ValueError, 'Service Jobs'):
            settlement.read_orders([path])

    def test_invalid_money_is_rejected(self):
        with self.assertRaises(ValueError):
            settlement.money('NaN')

    def test_cli_uses_food_subtotal_and_keeps_full_reference(self):
        path = self.workbook()
        output = Path(self.temp.name) / 'orders.csv'
        result = subprocess.run([sys.executable, str(Path(settlement.__file__)),
                                 str(path), '--output', str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with output.open(encoding='utf-8-sig') as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(rows[0]['order_amount'], '25.50')
        self.assertEqual(rows[0]['order_id'], '123')
        self.assertEqual(rows[0]['order_ref'], 'GMM-00000123')
        self.assertEqual(rows[0]['source'], 'GoMamam')
        repeat = subprocess.run([sys.executable, str(Path(settlement.__file__)),
                                 str(path), '--output', str(output)], capture_output=True, text=True)
        self.assertNotEqual(repeat.returncode, 0)
        with output.open(encoding='utf-8-sig') as handle:
            self.assertEqual(list(csv.DictReader(handle)), rows)


if __name__ == '__main__':
    unittest.main()
