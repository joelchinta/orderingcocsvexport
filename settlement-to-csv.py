#!/usr/bin/env python3
"""Convert GoMamam Service Jobs into a local CSV without email or API calls."""
import argparse
import csv
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
import re
import sys

from openpyxl import load_workbook

FIELDS = {
    'order_ref': 'ORDER REF', 'service_ref': 'SERVICE REF',
    'delivery_date': 'DELIVERY DATE', 'subtotal': 'SUBTOTAL', 'total': 'TOTAL',
    'merchant_net': 'MERCHANT NET (BND)', 'batch_id': 'BATCH ID',
    'business_date': 'BUSINESS DATE', 'entry_type': 'ENTRY TYPE',
    'service_status': 'SERVICE STATUS', 'service_type': 'SERVICE TYPE',
}
AMOUNTS = ('subtotal', 'total', 'merchant_net')


def money(value):
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise ValueError('Missing or invalid amount') from None
    if not number.is_finite() or number != number.quantize(Decimal('.01')):
        raise ValueError('Amount must be finite and have at most two decimal places')
    return format(number, '.2f')


def day(value):
    if isinstance(value, (date, datetime)):
        return value.strftime('%Y-%m-%d')
    # Numeric dates must have an Excel date style, so openpyxl decodes them.
    if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return date.fromisoformat(value).isoformat()
    raise ValueError('Missing or unsupported date')


def read_orders(paths):
    orders = {}
    for path in paths:
        workbook = load_workbook(path, read_only=True, data_only=True, keep_links=False)
        try:
            if 'Service Jobs' not in workbook.sheetnames:
                raise ValueError('Expected a settlement workbook with a Service Jobs sheet')
            rows = workbook['Service Jobs'].iter_rows(values_only=True)
            headers = next(rows, ())
            if any(headers.count(name) != 1 for name in FIELDS.values()):
                raise ValueError('Missing or duplicate Service Jobs columns')
            columns = {key: headers.index(name) for key, name in FIELDS.items()}
            for row_number, row in enumerate(rows, 2):
                if not any(value is not None for value in row):
                    continue
                values = {key: row[index] if index < len(row) else None
                          for key, index in columns.items()}
                try:
                    if values['entry_type'] != 'NORMAL':
                        raise ValueError('Adjustment entries require reconciliation; export stopped')
                    if values['service_status'] != 'COMPLETED':
                        raise ValueError('Expected completed service jobs; export stopped')
                    for key in ('order_ref', 'service_ref'):
                        if not re.fullmatch(r'GMM-\d+', str(values[key])):
                            raise ValueError('Missing or unsupported order/service reference')
                    values['delivery_date'] = day(values['delivery_date'])
                    values['business_date'] = day(values['business_date'])
                    for key in AMOUNTS:
                        values[key] = money(values[key])
                    for key in ('batch_id', 'service_type'):
                        if values[key] is None or str(values[key]).strip() == '':
                            raise ValueError('Missing batch or service type')
                    if values['service_type'] not in ('FOOD_DELIVERY', 'FOOD_PICKUP'):
                        raise ValueError('Unsupported service type; export stopped')
                    ref = values['order_ref']
                    if ref in orders and orders[ref] != values:
                        raise ValueError('Conflicting records for the same order; export stopped')
                    orders[ref] = values
                except (ValueError, InvalidOperation) as error:
                    raise ValueError(f'Service Jobs row {row_number}: {error}') from None
        finally:
            workbook.close()
    if not orders:
        raise ValueError('No order rows found; no CSV written')
    return sorted(orders.values(), key=lambda row: (row['delivery_date'], row['order_ref']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbooks', type=Path, nargs='+')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--amount-field', choices=AMOUNTS, default='subtotal',
                        help='Also emit order_amount using the selected accounting basis')
    args = parser.parse_args()
    try:
        orders = read_orders(args.workbooks)
        fields = list(FIELDS)
        fields.extend(['order_id', 'source'])
        for row in orders:
            row['order_id'] = str(int(row['order_ref'].removeprefix('GMM-')))
            row['source'] = 'GoMamam'
        if args.amount_field:
            fields.append('order_amount')
            for row in orders:
                row['order_amount'] = row[args.amount_field]
        # Validate every workbook before opening the output; never replace an existing file.
        with args.output.open('x', encoding='utf-8-sig', newline='') as output:
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            writer.writerows(orders)
        print(f'Exported {len(orders)} unique orders to {args.output}')
        for key in AMOUNTS:
            print(f'{key}: BND {sum(Decimal(row[key]) for row in orders):.2f}')
    except (OSError, ValueError, InvalidOperation) as error:
        print(f'Export failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
