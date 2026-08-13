# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# Frappe desktop/workspace module icon configuration

from frappe import _


def get_data():
    return [
        {
            "module_name": "Universal Scanner",
            "color": "blue",
            "icon": "octicon octicon-package",
            "type": "module",
            "label": _("Universal Scanner"),
        }
    ]
