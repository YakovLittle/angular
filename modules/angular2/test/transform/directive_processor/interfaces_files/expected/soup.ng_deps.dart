library dinner.soup.ng_deps.dart;

import 'soup.dart';
export 'soup.dart';
import 'package:angular2/src/reflection/reflection.dart' as _ngRef;
import 'package:angular2/src/core/annotations_impl/annotations.dart';

var _visited = false;
void initReflector() {
  if (_visited) return;
  _visited = true;
  _ngRef.reflector
    ..registerType(ChangingSoupComponent, {
      'factory': () => new ChangingSoupComponent(),
      'parameters': const [],
      'annotations': const [const Component(selector: '[soup]')],
      'interfaces': const [OnChange, AnotherInterface]
    });
}
