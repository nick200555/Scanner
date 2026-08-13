from setuptools import setup, find_packages

with open("requirements.txt") as f:
    install_requires = [
        line.strip()
        for line in f
        if line.strip() and not line.startswith("#")
    ]

from universal_scanner import __version__ as version

setup(
    name="universal_scanner",
    version=version,
    description="Reusable barcode scanning and inventory counting application for Frappe/ERPNext",
    author="Universal Scanner Contributors",
    author_email="info@example.com",
    packages=find_packages(),
    zip_safe=False,
    include_package_data=True,
    install_requires=install_requires,
)
