#! bash

# This script is run by npm when `npm version` is invoked
# At this point the package.json version field has been
# updated and a corresponding git tag has been created

set -e  # exit immediately on error
cd "$(dirname "$0")/.."

# Update the dist directory with a production build
bash ./scripts/build.sh production 

# Update the CHANGELOG file with the current version number and date

PACKAGE_VERSION=$(node -pe "require('./package.json').version")


# On Linux, the -i switch can be used without an extension argument
# On macOS, the -i switch must be followed by an extension argument (which can be empty)
# On Windows, the argument of the -i switch is optional, but if present it must follow it immediately without a space in between

sed -i'' -e 's/\[Unreleased\]/'"$PACKAGE_VERSION"' ('"$DATE_STAMP"')/g' CHANGELOG.md

git add CHANGELOG.md
git add dist
git commit -m $PACKAGE_VERSION

# Deploy this tagged release to Github.
# This will trigger a Travis build.
# In turn, the Travis build will publish to npm.
git push origin --tags
